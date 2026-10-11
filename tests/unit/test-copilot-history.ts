import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createAppStorage } from '../../src/app-storage.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';

const id = '11111111-1111-1111-1111-111111111111';
const provider = '22222222-2222-2222-2222-222222222222';
for (const mode of ['local', 'realtime'] as const) {
  for (const phase of ['transcribing', 'thinking', 'preparing-speech'] as const) {
    test(`${mode}: correction during ${phase} survives restart and excludes the removed turn from context`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'voice-correction-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const storage = createAppStorage(mode, root);
      storage.session.threadId = id;
      await storage.commitReply({ exchangeId: 'old', prompt: 'old question', answer: 'old answer' });
      const checkpoint = { id, exchanges: storage.session.currentExchanges };
      const revision = storage.session.captureOperation();
      if (phase === 'preparing-speech') await storage.commitReply({ exchangeId: 'wrong', prompt: 'wrong question', answer: 'wrong answer' });
      storage.session.interruptTurn(checkpoint);
      assert.equal(storage.session.matchesOperation(revision), false);
      assert.deepEqual(storage.session.currentExchanges, checkpoint.exchanges);
      const restored = createAppStorage(mode, root);
      restored.session.loadLocalHistory();
      assert.deepEqual(restored.session.currentExchanges, checkpoint.exchanges);
      assert.equal(restored.session.usesLocalContext, true);
      assert.match(restored.session.contextPrompt('replacement'), /old question/);
      assert.doesNotMatch(restored.session.contextPrompt('replacement'), /wrong question|wrong answer/);
    });
  }
}
test('LOCAL playback interruption retains the full committed answer', async t => {
  const root = mkdtempSync(join(tmpdir(), 'voice-playback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = createAppStorage('local', root); storage.session.threadId = id;
  const checkpoint = { id, exchanges: [] };
  await storage.commitReply({ exchangeId: 'full', prompt: 'question', answer: 'full answer' });
  storage.session.interruptTurn(checkpoint, { prompt: 'question', answer: 'full', interrupted: true });
  assert.equal(storage.session.currentExchanges[0].answer, 'full answer');
  assert.equal(storage.session.currentExchanges[0].interrupted, undefined);
});
test('API interruption saves its fragment once, persists the marker and rejects stale commits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'voice-fragment-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = createAppStorage('realtime', root); storage.session.threadId = id;
  const checkpoint = { id, exchanges: [] };
  const stale = storage.commitReply({ exchangeId: 'late', prompt: 'question', answer: 'late completion' });
  const fragment = { prompt: 'question', answer: 'received fragment', interrupted: true };
  storage.session.interruptTurn(checkpoint, fragment);
  await assert.rejects(stale, /changed before commit/);
  storage.session.interruptTurn(checkpoint, fragment);
  assert.equal(storage.session.currentExchanges.length, 1);
  const restored = createAppStorage('realtime', root); restored.session.loadLocalHistory();
  assert.deepEqual(restored.session.currentExchanges, storage.session.currentExchanges);
  assert.equal(restored.session.currentExchanges[0].interrupted, true);
  assert.match(restored.session.contextPrompt('next'), /Odpowiedź przerwana/);
  assert.throws(() => restored.session.interruptTurn({ id: provider, exchanges: [] }), /conversation changed/);
});
test('corrected provider context starts a fresh thread and persists its mapping', async t => {
  const root = mkdtempSync(join(tmpdir(), 'voice-provider-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = createAppStorage('realtime', root);
  storage.session.bindCodexThread(id, id);
  await storage.commitReply({ exchangeId: 'old', prompt: 'old question', answer: 'old answer' });
  const checkpoint = { id, exchanges: storage.session.currentExchanges };
  await storage.commitReply({ exchangeId: 'wrong', prompt: 'wrong question', answer: 'wrong answer' });
  storage.session.interruptTurn(checkpoint);
  class Provider extends CodexAppServer {
    calls: string[] = [];
    constructor() { super(root, storage.session, false, { storage }); }
    rebuild() { return this.openThread(); }
    protected override async request(method: string) { this.calls.push(method); return { thread: { id: provider } }; }
  }
  const client = new Provider(); await client.rebuild();
  assert.deepEqual(client.calls, ['thread/start']);
  const restored = createAppStorage('realtime', root); restored.session.loadLocalHistory();
  assert.equal(restored.session.codexThreadId, provider);
  assert.equal(restored.session.usesLocalContext, true);
  assert.doesNotMatch(restored.session.contextPrompt('next'), /wrong/);
  assert.deepEqual(restored.retention.retiredProviderThreadsFor(id), [id]);
  restored.retention = new ConversationRetention(restored.home, root, () => Date.now() + HISTORY_TTL_MS + 1000);
  const deleted: string[] = [];
  assert.equal(await restored.conversation.prune(async thread => { deleted.push(thread); }), true);
  assert.deepEqual(deleted, [id, provider]);
  assert.equal(restored.session.threadId, null);
});

test('export retains the interruption marker even when playback started before any transcript arrived', async () => {
  const { conversationMarkdown } = createRequire(import.meta.url)('../../electron/conversation-export.cjs');
  const markdown = await conversationMarkdown([{ question: 'question', answer: '', interrupted: true }], '.');
  assert.match(markdown, /question/);
  assert.match(markdown, /Odpowiedź przerwana/);
});
