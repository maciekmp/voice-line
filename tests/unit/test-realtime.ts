import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRealtime, realtimeHistory } from '../../src/codex-realtime.ts';
import { realtimePcm, decodeRealtimeAudio, type RealtimeAudioChunk } from '../../src/audio/realtime-pcm.ts';
import { codexErrorMessage } from '../../src/codex-error.ts';
import { createAppStorage } from '../../src/app-storage.ts';

const threadId = '11111111-1111-1111-1111-111111111111';
function wav(samples = [100, 200, -100, -200]): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((n, i) => b.writeInt16LE(n, 44 + i * 2));
  return b;
}
const chunk: RealtimeAudioChunk = { data: Buffer.from([100, 0, 200, 0]).toString('base64'), sampleRate: 24000,
  numChannels: 1, samplesPerChannel: 2, itemId: null };

class FakeRealtime extends CodexRealtime {
  calls: { method: string; params: any }[] = [];
  handler?: (method: string, params: any) => Promise<any>;
  player = { chunks: [] as RealtimeAudioChunk[], finished: false, stopped: false,
    write: (audio: RealtimeAudioChunk) => { this.player.chunks.push(audio); },
    finish: async () => { this.player.finished = true; }, stop: () => { this.player.stopped = true; } };
  override async start() {}
  override async startAudio() {}
  seed(exchanges: { question: string; answer: string }[]) {
    this.session.threadId = threadId;
    for (const exchange of exchanges) this.session.answered({ prompt: exchange.question, answer: exchange.answer });
  }
  protected override createPlayer() { return this.player; }
  protected override async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (this.handler) return this.handler(method, params);
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') this.emit('started');
    if (method === 'thread/realtime/appendAudio') {
      this.emit('transcript/done', { role: 'user', text: 'Co słychać?' });
      this.emit('outputAudio/delta', { audio: chunk });
      this.emit('transcript/done', { role: 'assistant', text: 'Wszystko dobrze.' });
    }
    return {};
  }
  emit(method: string, params = {}, id = threadId) { this.onNotification('thread/realtime/' + method, { threadId: id, ...params }); }
}
function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'voice-line-realtime-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'speech.wav'); writeFileSync(path, wav());
  return { cwd, path, client: new FakeRealtime(cwd) };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); }
  throw new Error('Test event did not arrive');
}

test('resamples recorder PCM without a WAV header and rejects corrupt/unsupported input', () => {
  assert.equal(realtimePcm(wav()).length, 12);
  assert.equal(realtimePcm(wav()).readInt16LE(0), 100);
  const unsupported = wav(); unsupported.writeUInt32LE(48000, 24);
  assert.throws(() => realtimePcm(unsupported), /16 kHz/);
  assert.throws(() => realtimePcm(wav().subarray(0, 45)), /Truncated/);
  assert.throws(() => realtimePcm(Buffer.alloc(0)), /Invalid/);
  assert.throws(() => realtimePcm(wav(new Array(16000 * 60 + 1).fill(0))), /60 seconds/);
});

test('validates base64 PCM alignment, declared length and format before playback', () => {
  assert.deepEqual(decodeRealtimeAudio(chunk), Buffer.from([100, 0, 200, 0]));
  for (const change of [{ data: '?' }, { sampleRate: 0 }, { numChannels: 3 }, { samplesPerChannel: 3 },
    { data: Buffer.from([1]).toString('base64'), samplesPerChannel: null }]) {
    assert.throws(() => decodeRealtimeAudio({ ...chunk, ...change }), /Invalid/);
  }
  // Large valid chunks must not overflow the regex engine's stack.
  assert.equal(decodeRealtimeAudio({ ...chunk, data: Buffer.alloc(24000 * 2).toString('base64'), samplesPerChannel: 24000 }).length, 48000);
});

test('sends 24 kHz speech with a VAD silence tail, drains playback, saves separate metadata', async t => {
  const { cwd, path, client } = fixture(t);
  writeFileSync(join(cwd, '.session.json'), 'original-local-session');
  const reply = await client.respondAudio(path);
  assert.deepEqual(reply, { prompt: 'Co słychać?', answer: 'Wszystko dobrze.', questionSource: 'voice' });
  const audio = client.calls.find(c => c.method === 'thread/realtime/appendAudio')!.params.audio;
  assert.equal(audio.sampleRate, 24000); assert.equal(audio.numChannels, 1);
  assert.equal(Buffer.from(audio.data, 'base64').length, realtimePcm(wav()).length + 57600);
  assert.ok(client.player.finished); assert.equal(client.player.chunks.length, 1);
  assert.equal(client.calls.at(-1)!.method, 'thread/realtime/stop');
  assert.deepEqual(client.currentExchanges, [{ question: reply.prompt, answer: reply.answer, questionSource: 'voice' }]);
  const metadata = JSON.parse(readFileSync(join(cwd, '.realtime-session.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), ['lastAnswerAt', 'threadId']);
  assert.equal(readFileSync(join(cwd, '.session.json'), 'utf8'), 'original-local-session');
});

test('voice/text exchanges within the budget reach subsequent audio prompts in order', async t => {
  const { path, client } = fixture(t);
  const history = Array.from({ length: 12 }, (_, i) => ({ question: `Question ${i}: "quoted"\nline`, answer: `Answer ${i}` }));
  client.seed(history);
  const reply = await client.respondAudio(path);
  await client.respondAudio(path);
  const prompts = client.calls.filter(c => c.method === 'thread/realtime/start').map(c => c.params);
  const messages = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  assert.deepEqual(messages(prompts[0].prompt), history.flatMap(({ question, answer }) => [
    { role: 'user', content: question }, { role: 'assistant', content: answer },
  ]));
  assert.deepEqual(messages(prompts[1].prompt).slice(-2), [
    { role: 'user', content: reply.prompt }, { role: 'assistant', content: reply.answer },
  ]);
  assert.equal(prompts[0].includeStartupContext, false);
});

test('audio provider forwards a bounded recent context without deleting older committed exchanges', async t => {
  const { path, client } = fixture(t);
  const history = Array.from({ length: 60 }, (_, i) => ({ question: `History question ${i}`, answer: `History answer ${i}` }));
  client.seed(history);
  await client.respondAudio(path);
  const prompt = client.calls.find(call => call.method === 'thread/realtime/start')!.params.prompt;
  const json = prompt.slice(prompt.lastIndexOf('\n') + 1);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 32 * 1024);
  assert.deepEqual(JSON.parse(json), history.slice(-32).flatMap(({ question, answer }) => [
    { role: 'user', content: question }, { role: 'assistant', content: answer },
  ]));
  assert.match(prompt, /pominięto 28/);
  assert.equal(client.currentExchanges.length, 61);
  assert.equal(client.currentExchanges[0].question, history[0].question);
});

test('reset and inactivity expiry remove previous context from the next audio session', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const { path, client } = fixture(t);
  client.seed([{ question: 'PRIVATE_OLD_FACT', answer: 'PRIVATE_OLD_ANSWER' }]);
  client.reset();
  await client.respondAudio(path);
  assert.ok(!client.calls.find(c => c.method === 'thread/realtime/start')!.params.prompt.includes('PRIVATE_OLD'));
  client.seed([{ question: 'EXPIRED_FACT', answer: 'EXPIRED_ANSWER' }]);
  now += 120_000;
  await client.respondAudio(path);
  const prompt = client.calls.filter(c => c.method === 'thread/realtime/start').at(-1)!.params.prompt;
  assert.ok(!prompt.includes('EXPIRED_'));
  assert.ok(!prompt.includes('Co słychać?'));
});

test('streams user/assistant transcripts before playback ends, including canonical completion', async t => {
  const { path, client } = fixture(t);
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    return {};
  };
  const transcripts: { role: string; text: string }[] = [];
  let releasePlayback!: () => void;
  client.player.finish = () => new Promise<void>(resolve => { releasePlayback = resolve; });
  t.after(() => { releasePlayback?.(); client.cancel(); });
  let settled = false;
  const task = client.respondAudio(path, undefined, { onTranscript: (role, text) => transcripts.push({ role, text }) });
  void task.then(() => { settled = true; });
  await until(() => client.calls.some(c => c.method.endsWith('/appendAudio')));
  client.emit('item/completed', { item: { type: 'transcriptSegment', role: 'user', text: 'Question' } });
  client.emit('transcript/delta', { role: 'assistant', delta: 'First' });
  client.emit('transcript/delta', { role: 'assistant', delta: ' part' });
  client.emit('outputAudio/delta', { audio: chunk });
  client.emit('item/completed', { item: { type: 'transcriptSegment', role: 'assistant', text: 'Final answer' } });
  assert.deepEqual(transcripts, [
    { role: 'user', text: 'Question' }, { role: 'assistant', text: 'First' },
    { role: 'assistant', text: 'First part' }, { role: 'assistant', text: 'Final answer' },
  ]);
  assert.equal(settled, false);
  assert.deepEqual(client.currentExchanges, []);
  await until(() => !!releasePlayback);
  assert.equal(settled, false);
  client.emit('transcript/done', { role: 'assistant', text: 'Ignored', }, 'other-thread');
  assert.equal(transcripts.length, 4);
  releasePlayback();
  assert.deepEqual(await task, { prompt: 'Question', answer: 'Final answer', questionSource: 'voice' });
  assert.deepEqual(client.currentExchanges, [{ question: 'Question', answer: 'Final answer', questionSource: 'voice' }]);
});

test('RPC acceptance is not startup success: async auth error fails without uploading audio', async t => {
  const { cwd, path, client } = fixture(t);
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') queueMicrotask(() => client.emit('error', { message: 'realtime conversation requires API key auth' }));
    return {};
  };
  await assert.rejects(client.respondAudio(path), /requires API key auth/);
  assert.ok(!client.calls.some(c => c.method.endsWith('/appendAudio')));
  assert.equal(client.calls.at(-1)!.method, 'thread/realtime/stop');
  assert.ok(!existsSync(join(cwd, '.realtime-session.json')));
});

test('final transcript permits trailing audio to drain; wrong-thread completion is ignored', async t => {
  const { path, client } = fixture(t);
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    return {};
  };
  const task = client.respondAudio(path);
  await until(() => client.calls.some(c => c.method.endsWith('/appendAudio')));
  client.emit('transcript/done', { role: 'assistant', text: 'Odpowiedź.' });
  client.emit('itemAdded', { item: { type: 'response.done' } }, 'other-thread');
  client.emit('outputAudio/delta', { audio: chunk });
  assert.equal(client.player.finished, false);
  client.emit('outputAudio/delta', { audio: chunk });
  await task;
  assert.equal(client.player.chunks.length, 2); assert.ok(client.player.finished);
});

test('abort stops playback and rejects the request; late audio cannot restart playback', async t => {
  const { cwd, path, client } = fixture(t);
  const controller = new AbortController();
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    return {};
  };
  const task = client.respondAudio(path, controller.signal);
  await until(() => client.calls.some(c => c.method.endsWith('/appendAudio')));
  client.emit('outputAudio/delta', { audio: chunk });
  controller.abort(); client.emit('outputAudio/delta', { audio: chunk });
  await assert.rejects(task, /Cancelled/);
  assert.equal(client.player.chunks.length, 1); assert.ok(client.player.stopped);
  assert.ok(!existsSync(join(cwd, '.realtime-session.json')));
});

test('audio delayed beyond completion while playback drains cannot commit a partial answer', async t => {
  const { cwd, path, client } = fixture(t);
  let finish!: () => void;
  client.player.finish = () => new Promise<void>(resolve => { finish = resolve; });
  const response = client.respondAudio(path);
  const rejected = assert.rejects(response, /Cancelled|completion boundary/);
  await until(() => !!finish);
  client.emit('outputAudio/delta', { audio: chunk });
  finish(); await rejected;
  assert.equal(client.player.chunks.length, 1);
  assert.equal(client.currentExchanges.length, 0);
  assert.equal(existsSync(join(cwd, '.realtime-session.json')), false);
});

test('failed realtime stop after playback leaves the answer uncommitted', async t => {
  const { cwd, path, client } = fixture(t);
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    if (method === 'thread/realtime/appendAudio') {
      client.emit('outputAudio/delta', { audio: chunk });
      client.emit('transcript/done', { role: 'assistant', text: 'Uncommitted' });
      client.emit('itemAdded', { item: { type: 'response.done' } });
    }
    if (method === 'thread/realtime/stop') throw new Error('stop failed');
    return {};
  };
  await assert.rejects(client.respondAudio(path), /stop failed/);
  assert.equal(client.currentExchanges.length, 0);
  assert.equal(existsSync(join(cwd, '.realtime-session.json')), false);
});

test('restart keeps committed realtime IDs and excludes transcripts from an aborted operation', async t => {
  const { cwd, path } = fixture(t);
  const storage = createAppStorage('realtime', cwd);
  const client = new FakeRealtime(cwd, storage, createAppStorage('imagegen', cwd));
  await client.respondAudio(path);
  const committed = client.currentExchanges;
  const controller = new AbortController();
  client.handler = async method => {
    if (method === 'thread/realtime/start') client.emit('started');
    if (method === 'thread/realtime/appendAudio') {
      client.emit('transcript/done', { role: 'user', text: 'Cancelled question' });
      client.emit('transcript/done', { role: 'assistant', text: 'Cancelled answer' });
      controller.abort();
    }
    return {};
  };
  await assert.rejects(client.respondAudio(path, controller.signal), /Cancelled/);
  client.stop();
  const restarted = new FakeRealtime(cwd, createAppStorage('realtime', cwd), createAppStorage('imagegen', cwd));
  restarted.handler = async () => { throw new Error('Committed history must not read the cancelled remote timeline'); };
  const history = await (restarted as any).readHistory(client.currentThreadId);
  assert.deepEqual(history, committed);
  assert.deepEqual(restarted.currentExchanges, committed);
  assert.ok(history.every((exchange: any) => !exchange.question.includes('Cancelled')));
});

test('legacy realtime metadata imports remote history once, then preserves its stored IDs', async t => {
  const { cwd } = fixture(t);
  const home = join(cwd, 'realtime-codex');
  const initial = createAppStorage('realtime', cwd);
  await initial.prepare();
  initial.session.threadId = threadId;
  // This reproduces pre-migration retained metadata with no application history file.
  writeFileSync(join(home, 'session.json'), JSON.stringify({ threadId, lastAnswerAt: Date.now() }));
  const client = new FakeRealtime(cwd, createAppStorage('realtime', cwd), createAppStorage('imagegen', cwd));
  let reads = 0;
  client.handler = async method => {
    if (method === 'thread/timeline/list') { reads++; return { data: [
      { position: 1, type: 'realtime', item: { type: 'transcriptSegment', role: 'user', text: 'Legacy Q' } },
      { position: 2, type: 'realtime', item: { type: 'transcriptSegment', role: 'assistant', text: 'Legacy A' } },
    ] }; }
    return {};
  };
  await (client as any).readHistory(threadId);
  const stored = client.currentExchanges;
  assert.equal(stored[0].answer, 'Legacy A');
  assert.ok(stored[0].id);
  assert.deepEqual(await (client as any).readHistory(threadId), stored);
  assert.equal(reads, 1);
  assert.deepEqual(createAppStorage('realtime', cwd).session.currentExchanges, stored);
});

test('an already aborted request does not start a session', async t => {
  const { path, client } = fixture(t);
  await assert.rejects(client.respondAudio(path, AbortSignal.abort()), /Cancelled/);
  assert.deepEqual(client.calls, []);
});

for (const event of ['closed', 'error']) test(`unexpected realtime ${event} rejects and tears down`, async t => {
  const { path, client } = fixture(t);
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    if (method.endsWith('/appendAudio')) client.emit(event, { reason: 'network', message: 'network' });
    return {};
  };
  await assert.rejects(client.respondAudio(path), /network/);
  assert.equal(client.calls.at(-1)!.method, 'thread/realtime/stop');
});

test('next request waits for previous stop acknowledgment', async t => {
  const { path, client } = fixture(t);
  let release!: () => void;
  const teardown = new Promise<void>(r => release = r);
  let stopCount = 0;
  client.handler = async method => {
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'thread/realtime/start') client.emit('started');
    if (method === 'thread/realtime/stop' && ++stopCount === 1) await teardown;
    return {};
  };
  const first = client.respondAudio(path);
  await until(() => client.calls.some(c => c.method.endsWith('/appendAudio')));
  client.cancel();
  const rejected = assert.rejects(first, /Cancelled/);
  const secondController = new AbortController();
  const second = client.respondAudio(path, secondController.signal);
  await until(() => stopCount === 1);
  assert.equal(client.calls.filter(c => c.method.endsWith('/start') && c.method.includes('realtime')).length, 1);
  release(); await rejected;
  await until(() => client.calls.filter(c => c.method.endsWith('/appendAudio')).length === 2);
  secondController.abort(); await assert.rejects(second, /Cancelled/);
});

test('canonical history combines voice segments and successful structured text replies', () => {
  const entries = [
    { position: 0, type: 'realtime', item: { type: 'transcriptSegment', role: 'user', text: 'Pytanie' } },
    { position: 1, type: 'realtime', item: { type: 'transcriptSegment', role: 'assistant', text: 'Część 1.' } },
    { position: 2, type: 'realtime', item: { type: 'transcriptSegment', role: 'assistant', text: 'Część 2.' } },
    { position: 3, type: 'realtime', item: { type: 'realtimeSessionClosed' } },
    { position: 4, type: 'item', turnId: 'text', item: { type: 'agentMessage', text: '{"prompt":"Tekst","answer":"OK"}' } },
    { position: 5, type: 'item', turnId: 'failed', item: { type: 'agentMessage', text: '{"prompt":"Błąd","answer":"Nie"}' } },
    { position: 6, type: 'turnCompleted', turnId: 'failed', status: 'failed' },
  ];
  assert.deepEqual(realtimeHistory(entries.reverse()), [{ question: 'Pytanie', answer: 'Część 1.\nCzęść 2.' }, { question: 'Tekst', answer: 'OK' }]);
});

test('missing key fails before server launch and has a useful Polish message', async t => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const { cwd } = fixture(t);
  await assert.rejects(new CodexRealtime(cwd).startAudio(), /requires OPENAI_API_KEY/);
  assert.match(codexErrorMessage(new Error('realtime conversation requires API key auth'), 'fallback'), /OPENAI_API_KEY/);
});
