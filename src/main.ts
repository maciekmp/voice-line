import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startKeyboard, type KeyEvent } from './keyboard/copilot-key.ts';
import { createCopilotGesture } from './keyboard/copilot-gesture.ts';
import { Recorder } from './audio/recorder.ts';
import { createVoiceEngine } from './voice/create-engine.ts';
import { codexErrorMessage } from './codex-error.ts';
import { imageRequest } from './image-artifacts.ts';

const debugKeys = process.argv.includes('--debug-keys');
const debug = process.argv.includes('--debug');
const desktop = process.argv.includes('--desktop');
function publish(state: string, extra: Record<string, unknown> = {}) {
  if (desktop && process.connected) process.send?.({ type: 'voice', state,
    mode: engine.mode, threadId: engine.currentThreadId, canRestorePrevious: engine.canRestorePrevious, ...extra });
}
const saveAudio = process.env.SAVE_AUDIO === '1';
const key = Number(process.env.COPILOT_VK ?? '134'); // F23; verify with --debug-keys.
const device = process.env.MIC_DEVICE ?? '';
const cwd = resolve('.');
if (!debugKeys && !device) {
  console.error('Set MIC_DEVICE. Run npm run diagnose:devices and npm run diagnose:keys first.');
  process.exit(1);
}
const engine = (() => {
  try { return createVoiceEngine(cwd, !debugKeys); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
})();

const recorder = new Recorder(device, tmpdir());
function publishLevel(source: 'listening' | 'speaking', level: number) {
  if (desktop && process.connected) process.send?.({ type: 'level', source, level });
}
recorder.onLevel = level => publishLevel('listening', level);
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
  engine.cancel();
}

function resetConversation() {
  desktopCopilot.cancel();
  interrupt(); recorder.cancel(); held = false; engine.reset();
  publish(servicesReady ? 'idle' : 'starting', { reset: true });
  console.log('New conversation.');
}

function prepareConversation() {
  const previous = engine.currentThreadId;
  engine.expireConversation();
  if (previous && !engine.currentThreadId) publish('thinking', { reset: true });
}

async function restorePreviousConversation() {
  if (!servicesReady || current || held || !engine.canRestorePrevious) return;
  const controller = new AbortController();
  const token = generation;
  current = controller;
  publish('thinking');
  try {
    const restored = await engine.restorePrevious(controller.signal);
    if (token !== generation) return;
    if (restored) publish('idle', { restored: true, exchanges: engine.currentExchanges });
    else publish('idle');
  } catch (error) {
    if (token !== generation) return;
    console.error(error);
    publish('error', { message: 'Nie udało się przywrócić rozmowy. Spróbuj ponownie.' });
  } finally { if (current === controller) current = null; }
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
    let prepared = false;
    let playbackStartedAt: number | undefined;
    const reply = await engine.respondAudio(wav, controller.signal, {
      onUpdate: (state, text) => {
        if (token !== generation) return;
        if (state === 'thinking' && !prepared) { prepareConversation(); prepared = true; }
        publish(state, { ...text, generatingImage: state === 'thinking' && Boolean(text?.question && imageRequest(text.question)) });
      },
      onPlaybackStart: () => {
        if (token !== generation || playbackStartedAt !== undefined) return;
        playbackStartedAt = performance.now();
        publish('speaking');
        logTime('Recording end to playback start', releasedAt, playbackStartedAt);
      },
      onLevel: level => { if (token === generation) publishLevel('speaking', level); },
      onTiming: logMilliseconds,
    });
    if (token !== generation) return;
    console.log(`\n[Question]\n${reply.prompt}\n\n[Answer]\n${reply.answer}\n`);
    logTime('Recording finalization', releasedAt, recordingDoneAt);
    if (playbackStartedAt !== undefined) logTime('Playback duration after player start', playbackStartedAt);
    logTime('Full cycle after key release', releasedAt);
    publish('idle', { exchanges: engine.currentExchanges, generatingImage: false });
    console.log('Ready.');
  } catch (error) {
    if (token === generation) { console.error(error); publish('error', { message: codexErrorMessage(error, 'Nie udało się przygotować lub odczytać odpowiedzi. Spróbuj nagrać pytanie ponownie. Szczegóły są w terminalu.'), ready: servicesReady }); }
  } finally {
    if (wav) {
      if (saveAudio) console.log(`Saved WAV recording: ${wav}`);
      else await unlink(wav).catch(() => {});
    }
    if (current === controller) current = null;
  }
}

async function processText(text: string) {
  if (!servicesReady || current || held) return;
  interrupt();
  const token = generation;
  const controller = new AbortController();
  current = controller;
  prepareConversation();
  publish('thinking', { question: text, answer: '', generatingImage: Boolean(imageRequest(text)) });
  try {
    await engine.respond(text, controller.signal);
    if (token === generation) publish('idle', { exchanges: engine.currentExchanges, generatingImage: false });
  } catch (error) {
    if (token === generation) {
      console.error(error);
      publish('error', { ready: servicesReady, message: codexErrorMessage(error, 'Nie udało się przygotować odpowiedzi. Wyślij wiadomość ponownie.') });
    }
  } finally { if (current === controller) current = null; }
}

const desktopCopilot = createCopilotGesture({
  down() {
    if (!servicesReady) return;
    held = true;
    interrupt();
    recordingStartedAt = performance.now();
    recorder.start();
  },
  hold() {
    if (!held) return;
    console.log('Recording...');
    publish('listening', { question: '', answer: '' });
  },
  tap() {
    if (held) {
      recorder.cancel();
      held = false;
      publish('idle');
    }
    if (process.connected) process.send?.({ type: 'ui', action: 'compose' });
  },
  release() {
    if (!held) return;
    held = false;
    const releasedAt = performance.now();
    logTime('Key hold', recordingStartedAt, releasedAt);
    void processSpeech(generation, releasedAt);
  },
});

function handle(event: KeyEvent) {
  if (debugKeys) { console.log(`${event.event.toUpperCase()} vk=${event.vk} scan=${event.scan} flags=${event.flags}`); return; }
  if (event.event === 'down') pressed.add(event.vk); else pressed.delete(event.vk);
  if (event.event === 'down' && event.vk === 78 && (pressed.has(17) || pressed.has(162) || pressed.has(163)) && (pressed.has(16) || pressed.has(160) || pressed.has(161))) {
    resetConversation(); return;
  }
  if (event.vk !== key) return;
  if (desktop) {
    if (event.event === 'down') desktopCopilot.down();
    else desktopCopilot.up();
    return;
  }
  if (!servicesReady) { if (event.event === 'down') console.log('Voice services are still starting.'); return; }
  if (event.event === 'down' && !held) {
    held = true;
    interrupt();
    recordingStartedAt = performance.now();
    recorder.start();
    console.log('Recording...');
    publish('listening', { question: '', answer: '' });
  } else if (event.event === 'up' && held) {
    held = false;
    const releasedAt = performance.now();
    logTime('Key hold', recordingStartedAt, releasedAt);
    const token = generation;
    void processSpeech(token, releasedAt);
  }
}

const keyboard = startKeyboard(handle, message => { console.error(message); publish('error', { message: 'Skrót Copilot jest niedostępny. Uruchom aplikację ponownie lub kliknij orb, aby napisać wiadomość.', ready: servicesReady }); }, { suppressVk: debugKeys ? 0 : key });
if (debugKeys) console.log('Keyboard events (Ctrl+C exits). Hold Copilot and note its vk.');
else {
  publish('starting');
  console.log(`Starting microphone and ${engine.startupDescription}...`);
  void Promise.all([engine.start(), recorder.startCapture()]).then(() => {
    servicesReady = true;
    publish('idle', { ready: true, exchanges: engine.currentExchanges });
    console.log(`Ready. Hold Copilot (vk=${key}); Ctrl+Shift+N resets; Ctrl+C exits.`);
  }).catch(error => { console.error(error); publish('error', { message: codexErrorMessage(error, 'Nie udało się uruchomić usług. Sprawdź mikrofon, Whisper, Codex i ustawienia .env, a następnie uruchom usługi ponownie.'), ready: false }); });
}
let maintaining = false;
const historyTimer = setInterval(() => {
  if (!servicesReady || held || current || maintaining) return;
  maintaining = true;
  const token = generation;
  void engine.maintainHistory?.().then(changed => {
    if (changed && token === generation && !current && !held) publish('idle', { exchanges: engine.currentExchanges, purgeHistory: true });
  }).catch(error => {
    console.error('Application history cleanup failed:', error);
    if (token === generation && !current && !held) publish('error', { message: 'Nie udało się usunąć starej historii. Aplikacja spróbuje ponownie za minutę.' });
  }).finally(() => { maintaining = false; });
}, 60_000);
historyTimer.unref();
function shutdown() { clearInterval(historyTimer); desktopCopilot.cancel(); interrupt(); recorder.shutdown(); engine.stop(); keyboard.stop(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (desktop) {
  process.on('disconnect', shutdown);
  process.on('message', (message: unknown) => {
    const command = (message as { command?: string })?.command;
    if (command === 'shutdown') shutdown();
    else if (command === 'text') {
      const text = (message as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim() && text.length <= 12000) void processText(text.trim());
    }
    else if (command === 'reset') resetConversation();
    else if (command === 'previous') void restorePreviousConversation();
    else if (command === 'cancel') { desktopCopilot.cancel(); interrupt(); recorder.cancel(); held = false; publish(servicesReady ? 'idle' : 'starting'); }
    else if (command === 'record') handle({ event: 'down', vk: key, scan: 0, flags: 0 });
    else if (command === 'release') handle({ event: 'up', vk: key, scan: 0, flags: 0 });
  });
}
