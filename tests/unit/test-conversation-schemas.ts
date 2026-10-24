import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exchangeSchema, conversationViewSchema } from '../../src/conversation-schemas.cjs';
import { decodeHistory, decodeMetadata, UnsupportedStorageVersion } from '../../src/conversation-format.ts';
import { parseDesktopRequest, parseWorkerEvent } from '../../src/desktop-validation.cjs';

const id = '12345678-1234-1234-1234-123456789abc';

test('shared schemas preserve the separate desktop and persisted exchange contracts', () => {
  const preview = { id: 'preview:1', revision: 0, question: 'Q', answer: 'A',
    imageTask: { threadId: 'preview:image', turnId: 'preview:turn' } };
  assert.equal(conversationViewSchema.safeParse({ id: 'preview', revision: 0,
    completed: [preview], pending: null }).success, true);
  assert.equal(exchangeSchema.safeParse(preview).success, false);
  assert.throws(() => decodeHistory([preview], id), /Invalid application conversation/);
  assert.equal(exchangeSchema.safeParse({ ...preview, id: 'exchange_1', revision: 1,
    imageTask: { threadId: id, turnId: 'turn_1' } }).success, true);
});

test('legacy migration keeps extension fields and the original exchange fingerprint', () => {
  const legacy = [{ question: 'Q', extension: { value: 42 }, answer: 'A' }];
  const expected = createHash('sha256').update(id).update('\0')
    .update(`legacy:0:${JSON.stringify(legacy[0])}`).digest('hex');
  const decoded = decodeHistory(legacy, id);
  assert.equal(decoded.exchanges[0].id, expected);
  assert.deepEqual(decoded.exchanges[0], { ...legacy[0], id: expected, revision: 1 });
  const metadata = decodeMetadata({ threadId: id, lastAnswerAt: 0,
    revision: 'ignored legacy field', receipts: 'ignored legacy field' });
  assert.deepEqual(metadata, { legacy: true, metadata: { threadId: id, lastAnswerAt: 0, version: 2, revision: 0 } });
});

test('versioned metadata rejects invalid nested maps and unsafe revisions without coercion', () => {
  const metadata = { version: 2, threadId: id, lastAnswerAt: 0, revision: 1 };
  const receipt = { [id]: { exchange_1: 'a'.repeat(64) } };
  assert.deepEqual(decodeMetadata({ ...metadata, receipts: receipt }).metadata.receipts, receipt);
  for (const invalid of [
    { ...metadata, revision: '1' }, { ...metadata, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...metadata, lastAnswerAt: Infinity }, { ...metadata, localContextIds: [null] },
    { ...metadata, providerThreads: { [id]: null } },
    { ...metadata, receipts: { [id]: { exchange_1: 'A'.repeat(64) } } },
  ]) assert.throws(() => decodeMetadata(invalid), /Invalid conversation metadata/);
  assert.throws(() => decodeMetadata({ ...metadata, version: 99 }), UnsupportedStorageVersion);
});

test('IPC keeps UTF-16 text limits, finite audio levels and detached nested values', () => {
  assert.equal(parseDesktopRequest('voice:text', '😀'.repeat(6001)), null);
  assert.ok(parseDesktopRequest('voice:text', '😀'.repeat(6000)));
  for (const level of [NaN, Infinity, -Infinity, '0.5']) {
    assert.equal(parseWorkerEvent({ type: 'level', source: 'listening', level }), null);
  }
  const input = { type: 'voice', state: 'idle', health: 'ready', ready: true, mode: 'local',
    capabilities: { text: { state: 'ready' }, recording: { state: 'ready' }, playback: { state: 'ready' } },
    threadId: id, canRestorePrevious: false, revision: 1, operationId: null,
    conversation: { id, revision: 1, pending: null, completed: [{ question: 'Q', answer: 'A',
      imageTask: { threadId: id, turnId: 'turn_1', extra: 'discard' } }] } };
  const parsed = parseWorkerEvent(input);
  assert.equal(parsed?.type, 'voice');
  if (parsed?.type !== 'voice') throw new Error('Expected voice snapshot');
  input.conversation.completed[0].imageTask.turnId = 'mutated';
  assert.deepEqual(parsed.conversation.completed[0].imageTask, { threadId: id, turnId: 'turn_1' });
});
