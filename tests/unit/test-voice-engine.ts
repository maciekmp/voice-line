import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalVoiceEngine } from '../../src/voice/local-engine.ts';
import { RealtimeVoiceEngine } from '../../src/voice/realtime-engine.ts';
import type { ConversationClient, VoiceCallbacks } from '../../src/voice-engine.ts';
import { createVoiceEngine } from '../../src/voice/create-engine.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const calls: string[] = [];
  const client: ConversationClient = {
    currentThreadId: null, currentExchanges: [], canRestorePrevious: false,
    start: async () => { calls.push('client.start'); }, stop: () => { calls.push('client.stop'); },
    cancel: () => { calls.push('client.cancel'); }, reset: () => { calls.push('client.reset'); },
    expireConversation: () => { calls.push('client.expire'); }, restorePrevious: async () => true,
    respond: async text => { calls.push(`respond:${text}`); return { prompt: 'Corrected', answer: 'Answer' }; },
  };
  const stt = { start: async () => { calls.push('stt.start'); }, stop: () => { calls.push('stt.stop'); },
    transcribe: async () => { calls.push('transcribe'); return 'Raw'; } };
  const speaker = { start: async () => { calls.push('tts.start'); }, stop: () => { calls.push('tts.stop'); },
    shutdown: () => { calls.push('tts.shutdown'); },
    speak: async (text: string, _signal?: AbortSignal, onStart?: () => void, onLevel?: (level: number) => void) => {
      calls.push(`speak:${text}`); onStart?.(); onLevel?.(0.5); return true;
    } };
  return { calls, client, stt, speaker, engine: new LocalVoiceEngine(client, stt, speaker) };
}

test('factory selects one engine at startup and validates only the selected services', t => {
  const directory = mkdtempSync(join(tmpdir(), 'voice-engine-'));
  const keys = ['VOICE_MODE', 'TTS_MODE', 'CODEX_MODE', 'WHISPER_MODEL'];
  const original = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.VOICE_MODE = 'realtime';
  process.env.TTS_MODE = 'invalid';
  delete process.env.CODEX_MODE;
  delete process.env.WHISPER_MODEL;
  const realtime = createVoiceEngine(directory);
  assert.equal(realtime.mode, 'realtime');
  process.env.VOICE_MODE = 'local';
  assert.equal(realtime.mode, 'realtime');
  assert.throws(() => createVoiceEngine(directory), /TTS_MODE/);
  process.env.TTS_MODE = 'sapi';
  assert.throws(() => createVoiceEngine(directory), /WHISPER_MODEL/);
  process.env.WHISPER_MODEL = 'test-model';
  assert.equal(createVoiceEngine(directory).mode, 'local');
});

test('local engine reports stages, question and answer before playback', async () => {
  const { calls, engine } = fixture();
  const updates: unknown[] = [];
  const result = await engine.respondAudio('speech.wav', undefined, {
    onUpdate: (state, text) => updates.push({ state, ...text }),
    onPlaybackStart: () => updates.push('playback'), onLevel: level => updates.push(level),
  });
  assert.deepEqual(result, { prompt: 'Corrected', answer: 'Answer' });
  assert.deepEqual(calls, ['transcribe', 'respond:Raw', 'speak:Answer']);
  assert.deepEqual(updates, [{ state: 'transcribing' }, { state: 'thinking', question: 'Raw' },
    { state: 'preparing-speech', question: 'Corrected', answer: 'Answer' }, 'playback', 0.5]);
});

test('local lifecycle manages its services and typed messages do not use STT/TTS', async () => {
  const { calls, engine } = fixture();
  await engine.start();
  assert.deepEqual(new Set(calls), new Set(['client.start', 'stt.start', 'tts.start']));
  calls.length = 0;
  await engine.respond('Typed');
  assert.deepEqual(calls, ['respond:Typed']);
  calls.length = 0;
  engine.reset();
  assert.ok(calls.includes('tts.stop') && calls.includes('client.reset'));
  engine.stop();
  assert.ok(calls.includes('client.stop') && calls.includes('stt.stop') && calls.includes('tts.shutdown'));
});

test('LOCAL leaves natural image intent to Codex, while /image explicitly selects generation', async () => {
  const { calls, client, stt, engine } = fixture();
  client.generateImage = async text => { calls.push(`image:${text}`); return { prompt: text, answer: 'Gotowe.' }; };
  await engine.respond('Wygeneruj obraz kota');
  assert.deepEqual(calls, ['respond:Wygeneruj obraz kota']);
  calls.length = 0;
  await engine.respond('/image kot');
  assert.deepEqual(calls, ['image:kot']);
  calls.length = 0;
  stt.transcribe = async () => 'Chciałbym ilustrację kota';
  await engine.respondAudio('speech.wav');
  assert.ok(calls.includes('respond:Chciałbym ilustrację kota'));
  assert.ok(!calls.some(call => call.startsWith('image:')));
});

test('abort after recognition or generation prevents starting the next stage', async () => {
  for (const stage of ['recognition', 'generation']) {
    const { calls, client, stt, engine } = fixture();
    const controller = new AbortController();
    if (stage === 'recognition') stt.transcribe = async () => { controller.abort(); return 'Raw'; };
    else client.respond = async () => { controller.abort(); return { prompt: 'Corrected', answer: 'Answer' }; };
    await assert.rejects(engine.respondAudio('speech.wav', controller.signal), /Cancelled/);
    assert.ok(!calls.some(call => call.startsWith('speak:')));
    if (stage === 'recognition') assert.ok(!calls.some(call => call.startsWith('respond:')));
  }
});

test('unintelligible speech does not reach Codex or TTS', async () => {
  const { calls, stt, engine } = fixture();
  stt.transcribe = async () => '*cisza*';
  await assert.rejects(engine.respondAudio('speech.wav'), /Nie rozpoznano mowy/);
  assert.deepEqual(calls, []);
});

test('realtime adapter replaces partial text, preserves prior context and ignores aborted callbacks', async () => {
  const { client } = fixture();
  client.currentExchanges.push({ question: 'Earlier', answer: 'Earlier answer' });
  const controller = new AbortController();
  const updates: unknown[] = [];
  const fake = { ...client, respondAudio: async (_wav: string, _signal?: AbortSignal, callbacks?: {
    onTranscript?: (role: 'user' | 'assistant', text: string) => void;
    onPlaybackStart?: () => void;
  }) => {
    callbacks?.onTranscript?.('user', 'Question');
    callbacks?.onPlaybackStart?.();
    callbacks?.onTranscript?.('assistant', 'Part');
    callbacks?.onTranscript?.('assistant', 'Full answer');
    controller.abort();
    callbacks?.onTranscript?.('assistant', 'Stale');
    return { prompt: 'Question', answer: 'Full answer' };
  } };
  const engine = new RealtimeVoiceEngine(fake);
  const callbacks: VoiceCallbacks = { onUpdate: (state, text) => updates.push({ state, ...text }) };
  await engine.respondAudio('speech.wav', controller.signal, callbacks);
  assert.equal(updates.length, 4);
  assert.deepEqual(updates.at(-1), { state: 'speaking', exchanges: [
    { question: 'Earlier', answer: 'Earlier answer' }, { question: 'Question', answer: 'Full answer' },
  ] });
  assert.equal(client.currentExchanges.length, 1);
  assert.equal(engine.mode, 'realtime');
});
