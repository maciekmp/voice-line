import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationController, type AudioRecorder, type ControllerClock } from '../../src/application-controller.ts';
import type { ApplicationEvent } from '../../src/application-contract.ts';
import type { VoiceEngine, VoiceCallbacks } from '../../src/voice-engine.ts';
import type { VoiceReply } from '../../src/conversation-contract.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
function fakeClock() {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
  const timer = (callback: () => void, delay: number, interval?: number) => {
    const id = ++nextId; timers.set(id, { at: now + delay, callback, interval });
    return { id, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  };
  const clear = (value: ReturnType<typeof setTimeout> | undefined) => timers.delete((value as unknown as { id?: number })?.id ?? -1);
  const clock: ControllerClock = { now: () => now, setTimeout: timer, clearTimeout: clear,
    setInterval: (callback, delay) => timer(callback, delay, delay), clearInterval: clear };
  return { clock, advance(ms: number) {
    const target = now + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, value] = entry; now = value.at;
      if (value.interval) value.at += value.interval; else timers.delete(id);
      value.callback();
    }
    now = target;
  }, get timers() { return timers.size; } };
}
function fixture(desktop = false) {
  const events: ApplicationEvent[] = [], calls: string[] = [], files: string[] = [], time = fakeClock();
  const reply = { prompt: 'Q', answer: 'A' };
  const engine: VoiceEngine = {
    mode: 'local', startupDescription: 'fake services', currentThreadId: '11111111-1111-1111-1111-111111111111',
    currentExchanges: [], canRestorePrevious: true,
    start: async () => { calls.push('engine.start'); }, stop: () => { calls.push('engine.stop'); },
    cancel: () => { calls.push('engine.cancel'); }, reset: () => { calls.push('engine.reset'); },
    expireConversation: () => {}, restorePrevious: async () => { calls.push('previous'); return true; },
    maintainHistory: async () => { calls.push('cleanup'); return false; },
    respond: async text => { calls.push(`text:${text}`); engine.currentExchanges.push({ question: text, answer: 'A' }); return reply; },
    respondAudio: async (_wav, _signal, callbacks: VoiceCallbacks = {}) => {
      calls.push('audio'); callbacks.onUpdate?.('transcribing'); callbacks.onUpdate?.('thinking', { question: 'Q' });
      callbacks.onUpdate?.('preparing-speech', { question: 'Q', answer: 'A' }); callbacks.onPlaybackStart?.(); callbacks.onLevel?.(0.5);
      engine.currentExchanges.push({ question: 'Q', answer: 'A' }); return reply;
    },
  };
  const recorder: AudioRecorder = {
    lastDurationSeconds: 1, lastRmsDbfs: -12, lastPeakDbfs: -6,
    startCapture: async () => { calls.push('capture'); }, start: () => { calls.push('record'); },
    stop: async () => { calls.push('record.stop'); return 'speech.wav'; }, cancel: () => { calls.push('record.cancel'); },
    shutdown: () => { calls.push('record.shutdown'); },
  };
  const controller = new ApplicationController({ engine, recorder, desktop, key: 134, clock: time.clock,
    emit: event => events.push(event), removeAudio: async wav => { files.push(wav); },
    log: { log() {}, error() {} }, operationTimeoutMs: 1000 });
  const voices = () => events.filter(event => event.type === 'voice');
  return { engine, recorder, controller, events, calls, files, time, voices, reply };
}

test('startup, text, invalid commands and previous use the public controller API without devices', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown());
  assert.equal(await f.controller.command({ command: 'text', text: 'not ready' }), false);
  await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(f.calls.filter(call => call === 'engine.start').length, 1);
  assert.equal(f.controller.snapshot().health, 'ready');
  for (const invalid of [null, [], { command: 'unknown' }, { command: 'text', text: ' ' }, { command: 'text', text: 'a'.repeat(12001) }]) {
    assert.equal(await f.controller.command(invalid), false);
  }
  assert.equal(await f.controller.command({ command: 'text', text: '  hello  ' }), true);
  assert.ok(f.calls.includes('text:hello'));
  assert.ok(!f.calls.includes('record') && !f.calls.includes('audio'));
  assert.equal(f.voices().at(-1)?.state, 'idle');
  assert.equal(f.voices().at(-1)?.revision, 1);
  assert.equal(await f.controller.command({ command: 'previous' }), true);
  assert.equal(f.voices().at(-1)?.restored, true);
  assert.equal(f.voices().at(-1)?.revision, 2);
});

test('CLI voice publishes stages, cleans audio and ignores key repeats', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  await f.controller.command({ command: 'record' }); await f.controller.command({ command: 'record' });
  assert.equal(f.calls.filter(call => call === 'record').length, 1);
  await f.controller.command({ command: 'release' }); await flush();
  assert.deepEqual(f.voices().slice(2).map(event => event.state), ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'idle']);
  assert.deepEqual(f.files, ['speech.wav']);
  assert.ok(f.events.some(event => event.type === 'level' && event.level === 0.5));
  assert.equal(f.controller.snapshot().operationId, null);
});

test('desktop short press composes without transcription; hold records through the same commands', async t => {
  const f = fixture(true); t.after(() => f.controller.shutdown()); await f.controller.start();
  await f.controller.command({ command: 'record' }); f.time.advance(249); await f.controller.command({ command: 'release' });
  assert.ok(f.events.some(event => event.type === 'ui' && event.action === 'compose'));
  assert.ok(!f.calls.includes('audio') && !f.calls.includes('record.stop'));
  await f.controller.command({ command: 'record' }); f.time.advance(250); await f.controller.command({ command: 'release' }); await flush();
  assert.ok(f.calls.includes('audio'));
});

test('desktop correction interrupts at key-down and reports correction instead of toggling', async t => {
  const f = fixture(true); t.after(() => f.controller.shutdown()); await f.controller.start();
  const response = deferred<VoiceReply>(); let signal!: AbortSignal; let restored = 0;
  f.engine.respond = async (_text, value) => { signal = value!; return response.promise; };
  f.engine.interruptTurn = (checkpoint, partial) => { restored++; assert.deepEqual(checkpoint.exchanges, []); assert.equal(partial, undefined); };
  const work = f.controller.command({ command: 'text', text: 'wrong' }); await flush();
  await f.controller.command({ command: 'record' });
  assert.equal(signal.aborted, true); assert.equal(restored, 1);
  assert.equal(f.controller.snapshot().conversation.pending, null);
  f.time.advance(80); await f.controller.command({ command: 'release' });
  assert.equal(f.events.filter(e => e.type === 'ui').at(-1)?.action, 'correct');
  response.resolve(f.reply); await work;
});

test('orb tap interrupts playback without recording and preserves received text', async t => {
  const f = fixture(true); t.after(() => f.controller.shutdown()); await f.controller.start();
  const response = deferred<VoiceReply>(); let callbacks!: VoiceCallbacks;
  f.engine.respondAudio = async (_wav, _signal, updates = {}) => { callbacks = updates; return response.promise; };
  let partial: VoiceReply | undefined;
  f.engine.interruptTurn = (_checkpoint, reply) => { partial = reply; };
  await f.controller.command({ command: 'record' }); f.time.advance(250);
  await f.controller.command({ command: 'release' }); await flush();
  callbacks.onUpdate?.('thinking', { question: 'question', answer: 'fragment' }); callbacks.onPlaybackStart?.();
  const captures = f.calls.filter(c => c === 'record').length;
  await f.controller.command({ command: 'tap' });
  assert.equal(f.calls.filter(c => c === 'record').length, captures);
  assert.equal(partial?.answer, 'fragment'); assert.equal(partial?.interrupted, true);
  assert.equal(f.events.filter(e => e.type === 'ui').at(-1)?.action, 'continue');
  response.resolve(f.reply); await flush();
});

test('a press begun while unavailable cannot record when startup completes during the gesture', async t => {
  const f = fixture(true); t.after(() => f.controller.shutdown());
  await f.controller.command({ command: 'record' }); await f.controller.start(); f.time.advance(250);
  await f.controller.command({ command: 'release' });
  assert.ok(!f.calls.includes('record') && !f.calls.includes('audio'));
  assert.equal(f.events.filter(e => e.type === 'ui').at(-1)?.action, 'compose');
  await f.controller.command({ command: 'record' }); f.time.advance(250);
  assert.equal(f.events.filter(e => e.type === 'ui').at(-1)?.action, 'voice-input');
});

for (const { desktop, duration } of [{ desktop: true, duration: 80 }, { desktop: true, duration: 500 }, { desktop: false, duration: 500 }]) {
  test(`${desktop ? 'desktop' : 'CLI'} Copilot interrupts playback and ${duration < 250 ? 'composes on tap' : 'records on hold'}`, async t => {
    const f = fixture(desktop); t.after(() => f.controller.shutdown()); await f.controller.start();
    const response = deferred<VoiceReply>(); let callbacks!: VoiceCallbacks; let signal!: AbortSignal;
    f.engine.respondAudio = async (_wav, value, updates = {}) => {
      assert.ok(value);
      signal = value; callbacks = updates; return response.promise;
    };
    await f.controller.command({ command: 'record' });
    if (desktop) f.time.advance(250);
    await f.controller.command({ command: 'release' }); await flush();
    callbacks.onPlaybackStart?.();
    assert.equal(f.controller.snapshot().state, 'speaking');
    const recordings = f.calls.filter(call => call === 'record').length;
    const cancellations = f.calls.filter(call => call === 'engine.cancel').length;
    await f.controller.command({ command: 'record' });
    assert.equal(signal.aborted, true, 'Playback is interrupted on key-down');
    assert.equal(f.controller.snapshot().state, desktop ? 'idle' : 'listening');
    await f.controller.command({ command: 'record' }); f.time.advance(duration);
    assert.equal(f.calls.filter(call => call === 'record').length, recordings + 1, 'Repeat cannot restart capture');
    assert.equal(f.calls.filter(call => call === 'engine.cancel').length, cancellations + 1);
    assert.equal(f.controller.snapshot().state, desktop && duration < 250 ? 'idle' : 'listening');
    const count = f.events.length;
    callbacks.onUpdate?.('speaking', { answer: 'late' }); callbacks.onLevel?.(.9);
    response.resolve(f.reply); await flush();
    assert.equal(f.events.length, count, 'Stopped playback cannot publish late updates');
    await f.controller.command({ command: 'release' }); await flush();
    assert.equal(f.events.some(event => event.type === 'ui' && event.action === 'continue'), desktop && duration < 250);
    assert.equal(f.calls.filter(call => call === 'record.stop').length, duration < 250 ? 1 : 2);
    assert.equal(f.controller.snapshot().state, 'idle');
  });
}

test('cancel suppresses late callbacks and next response waits until the previous provider call settles', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const first = deferred<VoiceReply>(); let active = 0, maximum = 0;
  f.engine.respond = async text => { active++; maximum = Math.max(maximum, active); f.calls.push(`text:${text}`);
    try { return text === 'first' ? await first.promise : f.reply; } finally { active--; } };
  const pending = f.controller.command({ command: 'text', text: 'first' }); await flush();
  assert.equal(await f.controller.command({ command: 'text', text: 'overlap' }), false);
  await f.controller.command({ command: 'cancel' });
  const before = f.voices().length;
  const next = f.controller.command({ command: 'text', text: 'next' }); await flush();
  assert.ok(!f.calls.includes('text:next'));
  first.resolve(f.reply); await pending; await next;
  assert.equal(maximum, 1);
  assert.deepEqual(f.voices().slice(before).map(event => event.state), ['thinking', 'idle']);
});

test('reset cancels voice and suppresses old output while keeping service health ready', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const audio = deferred<VoiceReply>(); let callback!: VoiceCallbacks;
  f.engine.respondAudio = async (_wav, _signal, callbacks = {}) => { callback = callbacks; return audio.promise; };
  await f.controller.command({ command: 'record' }); await f.controller.command({ command: 'release' }); await flush();
  await f.controller.command({ command: 'reset' });
  const before = f.events.length;
  callback.onUpdate?.('speaking', { answer: 'stale' }); callback.onLevel?.(0.9);
  audio.resolve(f.reply); await flush();
  assert.equal(f.events.length, before);
  assert.equal(f.voices().at(-1)?.reset, true);
  assert.equal(f.controller.snapshot().health, 'ready');
  assert.deepEqual(f.files, ['speech.wav']);
});

test('operation deadline cancels the provider, reports error and cannot publish a late success', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const response = deferred<VoiceReply>(); f.engine.respond = async () => response.promise;
  const pending = f.controller.command({ command: 'text', text: 'timeout' }); await flush();
  f.time.advance(1000);
  assert.equal(f.voices().at(-1)?.state, 'error');
  assert.match(String(f.voices().at(-1)?.message), /limit czasu/);
  const before = f.voices().length; response.resolve(f.reply); await pending;
  assert.equal(f.voices().length, before);
  assert.equal(f.controller.snapshot().operationId, null);
});

test('startup failure and shutdown during startup cannot resurrect services', async () => {
  const f = fixture(), startup = deferred<void>(); f.engine.start = () => startup.promise;
  const starting = f.controller.start(); await f.controller.shutdown(); const before = f.events.length;
  startup.resolve(); await starting;
  assert.equal(f.events.length, before);
  assert.equal(f.controller.snapshot().health, 'stopped');
  await f.controller.shutdown();
  assert.equal(f.calls.filter(call => call === 'engine.stop').length, 1);
  assert.equal(f.time.timers, 0);
  const failed = fixture(); failed.engine.start = async () => { throw new Error('service startup failed'); };
  await failed.controller.start();
  assert.equal(failed.controller.snapshot().health, 'error');
  assert.equal(failed.voices().at(-1)?.ready, false);
  await failed.controller.shutdown();
});

test('maintenance waits for idle, reports failures and retries on the injected clock', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  await f.controller.command({ command: 'record' }); f.time.advance(60000); await flush();
  assert.ok(!f.calls.includes('cleanup'));
  await f.controller.command({ command: 'cancel' });
  let fail = true;
  f.engine.maintainHistory = async () => { if (fail) throw new Error('filesystem'); return true; };
  assert.equal(await f.controller.maintainHistory(), false);
  assert.equal(f.voices().at(-1)?.state, 'error');
  assert.equal(f.controller.snapshot().health, 'ready');
  fail = false; f.time.advance(60000); await flush();
  assert.equal(f.voices().at(-1)?.purgeHistory, true);
});

test('cancelled queued audio is cleaned exactly once even when it never reaches the engine', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const first = deferred<VoiceReply>(); f.engine.respond = async () => first.promise;
  const pending = f.controller.command({ command: 'text', text: 'first' }); await flush();
  await f.controller.command({ command: 'record' }); await f.controller.command({ command: 'release' });
  await f.controller.command({ command: 'cancel' });
  first.resolve(f.reply); await pending; await flush();
  assert.ok(!f.calls.includes('audio'));
  assert.deepEqual(f.files, ['speech.wav']);
});

test('new response waits for an in-progress maintenance call', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const cleanup = deferred<boolean>(); f.engine.maintainHistory = () => cleanup.promise;
  const maintaining = f.controller.maintainHistory();
  const response = f.controller.command({ command: 'text', text: 'after cleanup' }); await flush();
  assert.ok(!f.calls.includes('text:after cleanup'));
  cleanup.resolve(true); await maintaining; await response;
  assert.ok(f.calls.includes('text:after cleanup'));
});

test('worker separates pending from completed, replaces stream text and drops pending on cancel', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown());
  const saved = { id: 'saved-exchange', revision: 1, question: 'saved', answer: 'saved answer' };
  f.engine.currentExchanges.push(saved);
  await f.controller.start();
  const response = deferred<VoiceReply>(); let callbacks!: VoiceCallbacks;
  f.engine.respondAudio = async (_wav, _signal, value = {}) => { callbacks = value; return response.promise; };
  await f.controller.command({ command: 'record' });
  assert.deepEqual(f.voices().at(-1)?.conversation.completed, [saved]);
  assert.equal(f.voices().at(-1)?.conversation.pending?.answer, '');
  await f.controller.command({ command: 'release' }); await flush();
  callbacks.onUpdate?.('thinking', { question: 'new', answer: 'part' });
  const partial = f.voices().at(-1)!.conversation;
  callbacks.onUpdate?.('speaking', { answer: 'full' });
  const full = f.voices().at(-1)!.conversation;
  assert.equal(full.pending?.id, partial.pending?.id);
  assert.ok(full.pending!.revision > partial.pending!.revision);
  assert.equal(full.pending?.answer, 'full');
  assert.deepEqual(full.completed, [saved]);
  await f.controller.command({ command: 'cancel' });
  assert.equal(f.voices().at(-1)?.conversation.pending, null);
  assert.deepEqual(f.voices().at(-1)?.conversation.completed, [saved]);
  response.resolve(f.reply); await flush();
  assert.deepEqual(f.engine.currentExchanges, [saved]);
});

test('worker keeps a committed LOCAL answer when playback is cancelled', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown()); await f.controller.start();
  const beforeCommitRevision = f.controller.snapshot().conversation.revision;
  const response = deferred<VoiceReply>(); let callbacks!: VoiceCallbacks;
  f.engine.respondAudio = async (_wav, _signal, value = {}) => { callbacks = value; return response.promise; };
  await f.controller.command({ command: 'record' }); await f.controller.command({ command: 'release' }); await flush();
  const committed = { id: 'local-exchange', revision: 1, question: 'Q', answer: 'A' };
  f.engine.currentExchanges.push(committed);
  callbacks.onUpdate?.('preparing-speech', { question: 'Q', answer: 'A', exchanges: [committed] });
  assert.equal(f.voices().at(-1)?.conversation.pending, null);
  assert.ok(f.voices().at(-1)!.conversation.revision > beforeCommitRevision);
  assert.deepEqual(f.voices().at(-1)?.conversation.completed, [committed]);
  await f.controller.command({ command: 'cancel' });
  assert.deepEqual(f.voices().at(-1)?.conversation.completed, [committed]);
  response.resolve(f.reply); await flush();
});

test('expiration clears completed history but preserves the pending question', async t => {
  const f = fixture(); t.after(() => f.controller.shutdown());
  f.engine.currentExchanges.push({ id: 'old', revision: 1, question: 'old', answer: 'old answer' });
  await f.controller.start();
  f.engine.expireConversation = () => { Object.assign(f.engine, { currentThreadId: null, currentExchanges: [] }); };
  const response = deferred<VoiceReply>(); f.engine.respond = async () => response.promise;
  const work = f.controller.command({ command: 'text', text: 'new question' }); await flush();
  const snapshot = f.controller.snapshot().conversation;
  assert.deepEqual(snapshot.completed, []);
  assert.equal(snapshot.pending?.question, 'new question');
  await f.controller.command({ command: 'cancel' });
  response.resolve(f.reply); await work;
});
