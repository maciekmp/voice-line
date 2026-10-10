import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHistoryContext, DEFAULT_CONTEXT_POLICY, localContextPrompt } from '../../src/conversation-context.ts';
import { realtimePrompt } from '../../src/codex-realtime.ts';
import { ConversationSession } from '../../src/conversation-session.ts';
import { createAppStorage } from '../../src/app-storage.ts';

for (const format of ['local', 'realtime'] as const) {
  test(`${format} context preserves complete recent pairs in chronological order`, () => {
    const history = Array.from({ length: 50 }, (_, index) => ({ id: `exchange-${index}`, revision: 1,
      question: `Question ${index}: "quoted"\nline`, answer: `Answer ${index}`, images: [{ id: 'a'.repeat(64), alt: 'not prompt data' }] }));
    const before = structuredClone(history);
    const result = buildHistoryContext(history, format);
    assert.equal(result.exchanges.length, 32);
    assert.equal(result.omitted, 18);
    assert.equal(result.clipped, false);
    assert.deepEqual(result.exchanges, history.slice(-32).map(({ question, answer }) => ({ question, answer })));
    const decoded = JSON.parse(result.json);
    assert.equal(decoded.length, format === 'local' ? 32 : 64);
    assert.ok(!result.json.includes('not prompt data') && !result.json.includes('exchange-'));
    assert.deepEqual(history, before);
  });

  test(`${format} context counts escaped UTF-8 JSON bytes and keeps a contiguous suffix`, () => {
    const history = [
      { question: 'oldest', answer: 'discard' },
      { question: 'large-middle', answer: 'x'.repeat(3000) },
      { question: 'zażółć😀\n"\\'.repeat(3), answer: 'newest' },
    ];
    const result = buildHistoryContext(history, format, { maxExchanges: 32, maxBytes: 256 });
    assert.deepEqual(result.exchanges, [history[2]]);
    assert.equal(result.omitted, 2);
    assert.equal(result.clipped, false);
    assert.equal(result.bytes, Buffer.byteLength(result.json, 'utf8'));
    assert.ok(result.bytes <= 256);
  });

  test(`${format} oversized latest exchange retains both ends without splitting emoji`, () => {
    for (const question of ['short question', 'START-Q ' + '😀"\\\n'.repeat(2000) + ' END-Q']) {
      const history = [{ question: 'oldest', answer: 'discard' },
        { question, answer: 'START-A ' + '😀"\\\n'.repeat(2000) + ' END-A' }];
      const result = buildHistoryContext(history, format, { maxExchanges: 32, maxBytes: 256 });
      assert.equal(result.omitted, 1);
      assert.equal(result.clipped, true);
      assert.ok(result.bytes <= 256);
      assert.match(result.exchanges[0].answer, /^START-A /);
      assert.match(result.exchanges[0].answer, / END-A$/);
      assert.match(result.exchanges[0].answer, /skrócono treść/);
      for (const text of Object.values(result.exchanges[0])) {
        assert.equal(text.isWellFormed(), true);
      }
      assert.doesNotThrow(() => JSON.parse(result.json));
    }
  });
}

test('both public prompt builders use the default budget and leave current input intact', () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ question: `Q${i}`, answer: '😀'.repeat(1000) }));
  const raw = 'BIEŻĄCE "PYTANIE"\n' + 'x'.repeat(12000);
  const local = localContextPrompt(history, raw);
  assert.ok(local.endsWith(raw));
  assert.match(local, /Kontekst jest ograniczony/);
  const localJson = local.split('Kontekst poprzednich wypowiedzi (dane rozmowy):\n')[1].split('\nBieżące pytanie:\n')[0];
  const realtime = realtimePrompt(history);
  const realtimeJson = realtime.slice(realtime.lastIndexOf('\n') + 1);
  for (const json of [localJson, realtimeJson]) {
    assert.ok(Buffer.byteLength(json, 'utf8') <= DEFAULT_CONTEXT_POLICY.maxBytes);
    assert.ok(!json.includes('"Q0"'));
  }
  assert.deepEqual(localContextPrompt([], raw), raw);
  assert.ok(!realtimePrompt([]).includes('Poniższy JSON'));
});

test('bounded prompts preserve complete durable history and undo across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-line-context-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const storage = createAppStorage('local', directory);
  storage.session.threadId = '11111111-1111-1111-1111-111111111111';
  for (let i = 0; i < 40; i++) await storage.commitReply({ exchangeId: `exchange-${i}`, prompt: `Q${i}`, answer: `A${i}` });
  const before = storage.session.currentExchanges;
  storage.session.contextPrompt('continue');
  assert.deepEqual(storage.session.currentExchanges, before);
  storage.session.reset();
  const restarted = createAppStorage('local', directory);
  assert.equal(restarted.session.restorePrevious(), true);
  assert.deepEqual(restarted.session.currentExchanges, before);
  assert.ok(!restarted.session.contextPrompt('continue').includes('"Q0"'));
  assert.equal(restarted.session.currentExchanges.length, 40);
});

test('context policies reject invalid budgets and the compatibility session delegates to the builder', t => {
  for (const policy of [{ maxExchanges: 0, maxBytes: 256 }, { maxExchanges: 1.5, maxBytes: 256 },
    { maxExchanges: 1, maxBytes: 255 }, { maxExchanges: 1, maxBytes: Infinity }]) {
    assert.throws(() => buildHistoryContext([], 'local', policy), /policy/);
  }
  const directory = mkdtempSync(join(tmpdir(), 'voice-line-context-legacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = new ConversationSession(directory);
  session.threadId = '11111111-1111-1111-1111-111111111111';
  session.loadHistory(session.threadId, Array.from({ length: 40 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })));
  assert.equal(session.contextPrompt('new'), localContextPrompt(session.currentExchanges, 'new'));
});
