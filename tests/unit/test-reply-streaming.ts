import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplyDecoder } from '../../src/reply-decoder.ts';
import { StreamingSpeechQueue } from '../../src/streaming-speech.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { ConversationSession } from '../../src/conversation-session.ts';
import { LocalVoiceEngine } from '../../src/voice/local-engine.ts';
import type { ConversationClient, SpeechPlayer, VoiceReply } from '../../src/conversation-contract.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('structured stream decodes every split of escapes, Unicode and Markdown without exposing JSON syntax', () => {
  const expected = { prompt: 'Pytanie „żółć” 😀', answer: 'Pierwsze zdanie.\n```js\nconst text = "a\\b";\n```\nDalszy tekst 😀.' };
  const raw = JSON.stringify(expected).replaceAll('😀', '\\ud83d\\ude00');
  for (let split = 0; split <= raw.length; split++) {
    const decoder = new ReplyDecoder();
    const initial = decoder.push(raw.slice(0, split));
    if (initial) {
      assert.ok(expected.answer.startsWith(initial.answer));
      assert.doesNotMatch(initial.answer, /[\uD800-\uDBFF]$/);
    }
    assert.deepEqual(decoder.push(raw.slice(split)), expected);
  }
  const decoder = new ReplyDecoder();
  for (let index = 0; index < raw.length; index++) {
    const value = decoder.push(raw[index]);
    if (value) assert.ok(expected.answer.startsWith(value.answer));
  }
  assert.deepEqual(decoder.push(''), expected);
  assert.equal(new ReplyDecoder().push('Working on it…'), undefined);
  assert.equal(new ReplyDecoder().push('{"answer":"bad\\q"}'), undefined);
});

test('sentence playback begins before completion, skips streamed fences and remains sequential', async () => {
  const calls: string[] = [], releases: (() => void)[] = [];
  let active = 0, maximum = 0, starts = 0;
  const speaker: SpeechPlayer = {
    start: async () => {}, shutdown() {}, stop() {},
    speak: async (text, _signal, onStart) => {
      calls.push(text); maximum = Math.max(maximum, ++active); onStart?.();
      await new Promise<void>(resolve => releases.push(resolve)); active--; return true;
    },
  };
  const queue = new StreamingSpeechQueue(speaker, undefined, { onStart: () => starts++ });
  const answer = 'Pierwsze zdanie.\n```js\nconst x = "secret.code";\n```\nOstatnie zdanie.';
  for (let index = 1; index <= answer.length; index++) queue.update(answer.slice(0, index));
  assert.deepEqual(calls, ['Pierwsze zdanie.']);
  const finished = queue.finish(answer);
  releases.shift()!(); await flush();
  assert.deepEqual(calls, ['Pierwsze zdanie.', 'Ostatnie zdanie.']);
  releases.shift()!(); await finished;
  assert.equal(maximum, 1); assert.equal(starts, 1);
  queue.dispose();
});

test('code-only speech is announced at final completion and no fenced code is spoken', async () => {
  const calls: string[] = [];
  const speaker: SpeechPlayer = { start: async () => {}, shutdown() {}, stop() {},
    speak: async text => { calls.push(text); return true; } };
  const queue = new StreamingSpeechQueue(speaker);
  const answer = '```js\nconsole.log("secret");\n```';
  for (let index = 1; index <= answer.length; index++) queue.update(answer.slice(0, index));
  assert.deepEqual(calls, []);
  await queue.finish(answer);
  assert.deepEqual(calls, ['Kod znajdziesz w oknie rozmowy.']);
  queue.dispose();
});

test('an incomplete long sentence waits for its ending rather than splitting at a word limit', async () => {
  const calls: string[] = [];
  const speaker: SpeechPlayer = { start: async () => {}, shutdown() {}, stop() {},
    speak: async text => { calls.push(text); return true; } };
  const queue = new StreamingSpeechQueue(speaker);
  const unfinished = 'Długi fragment zdania bez końcowej interpunkcji '.repeat(12);
  queue.update(unfinished);
  assert.deepEqual(calls, []);
  queue.update(unfinished + 'kończy się tutaj. ');
  assert.equal(calls.length, 1);
  await queue.finish(unfinished + 'kończy się tutaj. ');
  queue.dispose();
});

for (const reason of ['abort', 'divergence'] as const) test(`${reason} stops current speech and removes queued sentences`, async () => {
  const controller = new AbortController(), calls: string[] = [];
  let notices = 0, errors = 0, current: ReturnType<typeof deferred<boolean>> | undefined;
  const speaker: SpeechPlayer = { start: async () => {}, shutdown() {},
    stop() { current?.reject(new Error('Cancelled')); current = undefined; },
    speak: async (text, _signal, start) => { calls.push(text); current = deferred<boolean>(); start?.(); return current.promise; } };
  const queue = new StreamingSpeechQueue(speaker, controller.signal, { onDivergence: () => notices++, onError: () => errors++ });
  queue.update('Pierwsze zdanie. Drugie zdanie. ');
  assert.equal(calls.length, 1);
  if (reason === 'abort') controller.abort();
  await queue.finish(reason === 'abort' ? 'Pierwsze zdanie. Drugie zdanie. ' : 'Końcowa, zmieniona odpowiedź.');
  assert.equal(calls.length, 1); assert.equal(errors, 0); assert.equal(notices, reason === 'divergence' ? 1 : 0);
  queue.dispose();
});

test('TTS failure stops further speech while local inference continues to its complete text answer', async () => {
  const completion = deferred<VoiceReply>(), errors: string[] = [], updates: string[] = [], calls: string[] = [];
  const client: ConversationClient = {
    currentThreadId: null, currentExchanges: [], canRestorePrevious: false,
    start: async () => {}, stop() {}, cancel() {}, reset() {}, expireConversation() {}, restorePrevious: async () => false,
    respond: async (_text, _signal, _source, _image, _images, onText) => {
      onText?.({ prompt: 'Poprawione pytanie', answer: 'Pierwsze zdanie. ' });
      await flush();
      onText?.({ prompt: 'Poprawione pytanie', answer: 'Pierwsze zdanie. Pełna odpowiedź.' });
      return completion.promise;
    },
  };
  const speaker: SpeechPlayer = { start: async () => {}, shutdown() {}, stop() {},
    speak: async text => { calls.push(text); throw new Error('TTS unavailable'); } };
  const engine = new LocalVoiceEngine(client, { start: async () => {}, stop() {}, transcribe: async () => 'Surowe pytanie' }, speaker);
  const result = engine.respondAudio('fake.wav', undefined, {
    onUpdate: (_state, value) => { if (value?.answer) updates.push(value.answer); },
    onPlaybackError: error => errors.push(error.message),
  });
  await flush(); await flush();
  assert.deepEqual(errors, ['TTS unavailable']);
  completion.resolve({ prompt: 'Poprawione pytanie', answer: 'Pierwsze zdanie. Pełna odpowiedź.' });
  const reply = await result;
  assert.equal(reply.answer, 'Pierwsze zdanie. Pełna odpowiedź.');
  assert.deepEqual(calls, ['Pierwsze zdanie.']);
  assert.ok(updates.includes('Pierwsze zdanie. Pełna odpowiedź.'));
});

test('app-server projects matching deltas before completion, ignores commentary and commits only final text', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-text-stream-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const threadId = '11111111-1111-1111-1111-111111111111', turnId = 'turn_stream';
  const accepted = deferred<void>();
  class Server extends CodexAppServer {
    override async start() {}
    emit(method: string, params: any) { (this as any).onMessage({ method, params: { threadId, turnId, ...params } }); }
    protected override async request(method: string): Promise<any> {
      if (method === 'thread/start') return { thread: { id: threadId } };
      if (method === 'turn/start') {
        this.emit('item/agentMessage/delta', { turnId: 'previous', itemId: 'old', delta: '{"answer":"old"}' });
        this.emit('item/started', { item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
        this.emit('item/agentMessage/delta', { itemId: 'commentary', delta: '{"prompt":"Q","answer":"commentary"}' });
        this.emit('item/completed', { item: { id: 'commentary', type: 'agentMessage', text: '{"prompt":"Q","answer":"commentary"}' } });
        this.emit('item/started', { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer' } });
        this.emit('item/agentMessage/delta', { itemId: 'answer', delta: '{"prompt":"Pytanie","answer":"Pierwsze zdanie. ' });
        accepted.resolve();
        return { turn: { id: turnId } };
      }
      return {};
    }
  }
  const server = new Server(cwd, new ConversationSession(cwd), true);
  t.after(() => server.stop());
  const previews: { prompt?: string; answer: string }[] = [];
  const result = server.respond('Q', undefined, 'text', undefined, undefined, value => previews.push(value));
  await accepted.promise; await flush();
  assert.deepEqual(previews, [{ prompt: 'Pytanie', answer: 'Pierwsze zdanie. ' }]);
  assert.equal(server.currentExchanges.length, 0);
  server.emit('item/agentMessage/delta', { itemId: 'answer', delta: 'Pełna odpowiedź."}' });
  server.emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: '{"prompt":"Pytanie","answer":"Pierwsze zdanie. Pełna odpowiedź."}' } });
  server.emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
  server.emit('item/agentMessage/delta', { itemId: 'late', delta: '{"answer":"stale after completion"}' });
  const reply = await result;
  assert.equal(reply.answer, 'Pierwsze zdanie. Pełna odpowiedź.');
  assert.ok(reply.firstTextMs !== undefined && reply.firstTextMs >= 0);
  assert.equal(server.currentExchanges.length, 1);
  assert.equal(previews.length, 2);
  const cancelledPreviews: { prompt?: string; answer: string }[] = [];
  const cancelled = server.respond('cancel', undefined, 'text', undefined, undefined, value => cancelledPreviews.push(value));
  await flush();
  const beforeCancel = cancelledPreviews.length;
  server.cancel();
  server.emit('item/agentMessage/delta', { itemId: 'answer', delta: 'stale after cancel"}' });
  server.emit('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  await assert.rejects(cancelled, /Cancelled/);
  assert.equal(cancelledPreviews.length, beforeCancel);
  assert.equal(server.currentExchanges.length, 1);
});
