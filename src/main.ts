import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startKeyboard, type KeyEvent } from './keyboard/copilot-key.ts';
import { Recorder } from './audio/recorder.ts';
import { WhisperTranscriber } from './stt/transcriber.ts';
import { CodexClient } from './codex.ts';
import { CodexAppServer } from './codex-app-server.ts';
import { Speaker } from './speaker.ts';
import { PiperSpeaker } from './piper-speaker.ts';

const debugKeys = process.argv.includes('--debug-keys');
const debug = process.argv.includes('--debug');
const saveAudio = process.env.SAVE_AUDIO === '1';
const key = Number(process.env.COPILOT_VK ?? '134'); // F23; verify with --debug-keys.
const device = process.env.MIC_DEVICE ?? '';
const model = process.env.WHISPER_MODEL ?? '';
const binary = process.env.WHISPER_BIN ?? 'whisper-cli.exe';
const language = process.env.STT_LANGUAGE ?? 'pl';
const ttsMode = process.env.TTS_MODE ?? 'sapi';
const cwd = resolve('.');

if (!debugKeys && ttsMode !== 'sapi' && ttsMode !== 'piper') {
  console.error('TTS_MODE must be sapi or piper.');
  process.exit(1);
}

if (!debugKeys && (!device || !model)) {
  console.error('Set MIC_DEVICE and WHISPER_MODEL. Run npm run devices and npm run keys first.');
  process.exit(1);
}

const recorder = new Recorder(device, tmpdir());
const stt = new WhisperTranscriber(binary, model, language);
const codex = process.env.CODEX_MODE === 'cli' ? new CodexClient(cwd) : new CodexAppServer(cwd);
const speaker = ttsMode === 'piper' ? new PiperSpeaker() : new Speaker();
let held = false, generation = 0, current: AbortController | null = null;
let recordingStartedAt = 0;
let servicesReady = false;
const pressed = new Set<number>();

function logTime(label: string, startedAt: number, endedAt = performance.now()) {
  if (debug) console.log(`[time] ${label}: ${((endedAt - startedAt) / 1000).toFixed(2)} s`);
}

function logMilliseconds(label: string, milliseconds?: number) {
  if (debug && milliseconds !== undefined) console.log(`[time] ${label}: ${(milliseconds / 1000).toFixed(2)} s`);
}

function interrupt() {
  generation++;
  current?.abort();
  current = null;
  codex.cancel();
  speaker.stop();
}

async function processSpeech(token: number, releasedAt: number) {
  const controller = new AbortController();
  current = controller;
  let wav = '';
  try {
    wav = await recorder.stop();
    if (token !== generation) return;
    const recordingDoneAt = performance.now();
    if (debug) console.log(`[audio] ${recorder.lastDurationSeconds.toFixed(2)} s, RMS ${recorder.lastRmsDbfs.toFixed(1)} dBFS, peak ${recorder.lastPeakDbfs.toFixed(1)} dBFS`);
    console.log('Transcribing...');
    const raw = await stt.transcribe(wav, controller.signal);
    const sttDoneAt = performance.now();
    if (!raw || !raw.replace(/\*[^*]+\*/g, '').trim()) { console.log('No intelligible speech recognized. Check the microphone or save the WAV with SAVE_AUDIO=1.'); return; }
    if (debug) console.log(`\n[Raw transcription]\n${raw}\n`);
    console.log('Preparing answer...');
    const { prompt, answer, startupMs, turnMs } = await codex.respond(raw, controller.signal);
    if (token !== generation) return;
    const codexDoneAt = performance.now();
    console.log(`\n[Question]\n${prompt}\n`);
    if (debug) console.log(`Thread: ${codex.currentThreadId}`);
    console.log(`\n[Answer]\n${answer}\n`);
    console.log('Speaking...');
    let playbackStartedAt: number | undefined;
    const playbackWasReported = await speaker.speak(answer, controller.signal, () => {
      if (token !== generation || playbackStartedAt !== undefined) return;
      playbackStartedAt = performance.now();
      if (!debug) return;
      console.log();
      logTime(`Recording end to playback start (${ttsMode === 'piper' ? 'FFplay' : 'SAPI'})`, releasedAt, playbackStartedAt);
      logTime('Recording finalization', releasedAt, recordingDoneAt);
      logTime('STT', recordingDoneAt, sttDoneAt);
      logTime('Codex (cleanup + answer)', sttDoneAt, codexDoneAt);
      logMilliseconds('  Codex: request accepted', startupMs);
      logMilliseconds('  Codex: turn to final answer', turnMs);
      logTime('TTS startup to playback', codexDoneAt, playbackStartedAt);
    });
    if (token === generation) {
      if (debug && !playbackWasReported) console.log('[time] Playback start unavailable: audio player did not report a running audio clock.');
      if (playbackStartedAt !== undefined) logTime('Playback duration after player start', playbackStartedAt);
      logTime('Full cycle after key release', releasedAt);
      console.log('Ready.');
    }
  } catch (error) {
    if (token === generation) console.error(error);
  } finally {
    if (wav) {
      if (saveAudio) console.log(`Saved WAV recording: ${wav}`);
      else await unlink(wav).catch(() => {});
    }
    if (current === controller) current = null;
  }
}

function handle(event: KeyEvent) {
  if (debugKeys) { console.log(`${event.event.toUpperCase()} vk=${event.vk} scan=${event.scan} flags=${event.flags}`); return; }
  if (event.event === 'down') pressed.add(event.vk); else pressed.delete(event.vk);
  if (event.event === 'down' && event.vk === 78 && (pressed.has(17) || pressed.has(162) || pressed.has(163)) && (pressed.has(16) || pressed.has(160) || pressed.has(161))) {
    interrupt(); recorder.cancel(); held = false; codex.reset(); console.log('New conversation.'); return;
  }
  if (event.vk !== key) return;
  if (!servicesReady) { if (event.event === 'down') console.log('Microphone, Whisper, Codex, and TTS are still starting.'); return; }
  if (event.event === 'down' && !held) {
    held = true;
    interrupt();
    recordingStartedAt = performance.now();
    recorder.start();
    console.log('Recording...');
  } else if (event.event === 'up' && held) {
    held = false;
    const releasedAt = performance.now();
    logTime('Key hold', recordingStartedAt, releasedAt);
    const token = generation;
    void processSpeech(token, releasedAt);
  }
}

const keyboard = startKeyboard(handle, message => console.error(message));
if (debugKeys) console.log('Keyboard events (Ctrl+C exits). Hold Copilot and note its vk.');
else {
  console.log(`Starting microphone, Whisper${process.env.WHISPER_THREADS ? ` (${process.env.WHISPER_THREADS} threads)` : ''}, Codex${process.env.CODEX_MODEL ? ` (${process.env.CODEX_MODEL})` : ''}, and TTS (${ttsMode})...`);
  void Promise.all([recorder.startCapture(), stt.start(), codex.start(), speaker.start()]).then(() => {
    servicesReady = true;
    console.log(`Ready. Hold Copilot (vk=${key}); Ctrl+Shift+N resets; Ctrl+C exits.`);
  }).catch(error => console.error(error));
}
process.on('SIGINT', () => { interrupt(); recorder.shutdown(); stt.stop(); codex.stop(); speaker.shutdown(); keyboard.stop(); process.exit(0); });
