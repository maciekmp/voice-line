import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppStorage, type AppStorage } from '../../src/app-storage.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { CodexClient } from '../../src/codex.ts';
import { conversationId, codexThreadId, turnId, imageId, type CodexThreadId } from '../../src/conversation-identifiers.ts';

const first = '11111111-1111-1111-1111-111111111111', second = '22222222-2222-2222-2222-222222222222';
class Provider extends CodexAppServer {
  calls: { method: string; params: any }[] = [];
  remoteIds = [first, second];
  constructor(storage: AppStorage) { super(storage.home, storage.session, false, { storage }); }
  override async start() {}
  async openSelected() { await this.openThread(); }
  protected override async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: this.remoteIds.shift()! } };
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      const turn = `turn_${this.calls.length}`;
      queueMicrotask(() => {
        (this as any).onMessage({ method: 'item/completed', params: { threadId: params.threadId,
          item: { type: 'agentMessage', text: '{"prompt":"Q","answer":"A"}' } } });
        (this as any).onMessage({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turn, status: 'completed' } } });
      });
      return { turn: { id: turn } };
    }
    return {};
  }
}
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'voice-identities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('identifier constructors validate values and their TypeScript brands are distinct', () => {
  const application = conversationId(first);
  // @ts-expect-error Application IDs cannot be passed as branded Codex thread IDs.
  const incompatible: CodexThreadId = application;
  assert.equal(incompatible, first);
  assert.equal(codexThreadId(first), first); assert.equal(turnId('turn_1'), 'turn_1');
  assert.equal(imageId('a'.repeat(64)), 'a'.repeat(64));
  assert.throws(() => conversationId('../file')); assert.throws(() => codexThreadId('turn_1'));
  assert.throws(() => turnId('../turn')); assert.throws(() => imageId('A'.repeat(64)));
});

test('retained app IDs stay separate across reply, restart, undo, resume and deletion', async t => {
  const root = await directory(t), storage = createAppStorage('realtime', root);
  let now = Date.now();
  storage.retention = new ConversationRetention(storage.home, root, () => now);
  const provider = new Provider(storage);
  await provider.respond('first');
  const appFirst = provider.currentThreadId!;
  assert.notEqual(appFirst, first);
  assert.equal(provider.currentCodexThreadId, first);
  assert.equal(provider.calls.find(call => call.method === 'turn/start')!.params.threadId, first);
  assert.ok(existsSync(join(storage.home, `${appFirst}.json`)));
  assert.equal(existsSync(join(storage.home, `${first}.json`)), false);
  const metadata = JSON.parse(readFileSync(join(storage.home, 'session.json'), 'utf8'));
  assert.equal(metadata.providerThreads[appFirst], first);
  provider.reset(); await provider.respond('second');
  const appSecond = provider.currentThreadId!;
  assert.notEqual(appSecond, second); assert.notEqual(appSecond, appFirst);
  assert.equal(await provider.restorePrevious(), true);
  assert.equal(provider.currentThreadId, appFirst);
  assert.equal(provider.calls.filter(call => call.method === 'thread/resume').at(-1)!.params.threadId, first);
  const restarted = createAppStorage('realtime', root);
  restarted.retention = new ConversationRetention(restarted.home, root, () => now);
  const resumed = new Provider(restarted);
  await resumed.openSelected();
  assert.equal(resumed.currentThreadId, appFirst);
  assert.equal(resumed.calls.at(-1)!.params.threadId, first);
  assert.equal(restarted.session.providerThreadFor(appSecond), second);
  now += HISTORY_TTL_MS;
  await resumed.maintainHistory();
  assert.deepEqual(resumed.calls.filter(call => call.method === 'thread/delete').map(call => call.params.threadId).sort(), [first, second]);
  assert.equal(existsSync(join(storage.home, `${appFirst}.json`)), false);
  assert.equal(existsSync(join(storage.home, `${appSecond}.json`)), false);
  assert.equal(resumed.currentThreadId, null);
});

test('retention remembers the provider ID of an unanswered thread after restart', async t => {
  const root = await directory(t), storage = createAppStorage('realtime', root);
  let now = Date.now(); storage.retention = new ConversationRetention(storage.home, root, () => now);
  const provider = new Provider(storage);
  await provider.openSelected();
  const appId = provider.currentThreadId!;
  assert.notEqual(appId, first);
  assert.equal(storage.retention.providerThreadFor(appId), first);
  const restarted = createAppStorage('realtime', root);
  restarted.retention = new ConversationRetention(restarted.home, root, () => now);
  const cleaner = new Provider(restarted);
  now += HISTORY_TTL_MS;
  await cleaner.maintainHistory();
  assert.equal(cleaner.calls.find(call => call.method === 'thread/delete')!.params.threadId, first);
});

test('retained CLI resumes with the provider ID and keeps the application history ID', async t => {
  const root = await directory(t), storage = createAppStorage('realtime', root);
  const cli = new CodexClient(root, 'codex.cmd', storage);
  const args: string[][] = [];
  Object.assign(cli, { start: async () => {},
    historyServer: { beginExternalTurn: async () => () => {}, readLatestExchange: async () => ({ question: 'Q', answer: 'A' }) },
    run: async (input: string[]) => { args.push(input); return { text: '{"prompt":"Q","answer":"A"}', threadId: first }; },
  });
  await cli.respond('first'); const appId = cli.currentThreadId!;
  assert.notEqual(appId, first);
  await cli.respond('second');
  assert.equal(args[1].at(-2), first);
  assert.equal(cli.currentThreadId, appId);
  assert.equal(storage.retention.providerThreadFor(appId), first);
  assert.equal(createAppStorage('realtime', root).session.codexThreadId, first);
});
