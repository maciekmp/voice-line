// Optional native regression: configured Piper + FFplay, no microphone or Codex request.
// Run: node --env-file-if-exists=.env --experimental-strip-types tests/native/test-piper-interruption.ts
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { ApplicationController, type AudioRecorder } from '../../src/application-controller.ts';
import { ApplicationInput } from '../../src/application-input.ts';
import { LocalVoiceEngine } from '../../src/voice/local-engine.ts';
import { PiperSpeaker } from '../../src/piper-speaker.ts';
import { loadPiperConfig } from '../../src/app-config.ts';
import type { ConversationClient, ConversationExchange } from '../../src/conversation-contract.ts';
import type { ApplicationEvent } from '../../src/application-contract.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean) {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > 15_000) throw new Error('Timed out waiting for native playback');
    await sleep(30);
  }
}
const originalAudioDriver = process.env.SDL_AUDIODRIVER;
process.env.SDL_AUDIODRIVER = 'dummy'; // Exercise the real player silently.
try {
  const config = loadPiperConfig();
  console.log(`Native player: ${config.player}`);
  for (const duration of [80, 350]) {
    const speaker = new PiperSpeaker(undefined, undefined, undefined, config);
    const events: ApplicationEvent[] = [];
    const exchanges: ConversationExchange[] = [];
    const client: ConversationClient = {
      currentThreadId: null, currentExchanges: exchanges, canRestorePrevious: false,
      start: async () => {}, stop() {}, cancel() {}, reset() {}, expireConversation() {},
      restorePrevious: async () => false,
      respond: async () => {
        const reply = { prompt: 'Pytanie testowe.', answer: 'To jest długa odpowiedź służąca do sprawdzenia zatrzymywania odtwarzacza. '.repeat(12) };
        exchanges.push({ question: reply.prompt, answer: reply.answer });
        return reply;
      },
    };
    const recorder: AudioRecorder = {
      startCapture: async () => {}, start() {}, stop: async () => 'simulated.wav', cancel() {}, shutdown() {},
      lastDurationSeconds: 1, lastRmsDbfs: -12, lastPeakDbfs: -6,
    };
    const engine = new LocalVoiceEngine(client, { start: async () => {}, stop() {}, transcribe: async () => 'Pytanie testowe.' }, speaker, 'piper');
    const controller = new ApplicationController({ engine, recorder,
      emit: event => events.push(event), removeAudio: async () => {}, log: { log() {}, error: console.error } });
    const input = new ApplicationInput(controller, event => events.push(event));
    try {
      await controller.start();
      await input.command({ command: 'record' }); await sleep(300);
      await input.command({ command: 'release' });
      await waitFor(() => controller.snapshot().state === 'speaking');
      // Capture the exact owned player before interruption, not unrelated processes.
      const player = (speaker as unknown as { active: { player: ChildProcess } }).active.player;
      assert.ok(player.pid);
      assert.equal(player.exitCode, null);
      const closed = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Native player survived Copilot interruption')), 1000);
        player.once('close', () => { clearTimeout(timeout); resolve(); });
      });
      const started = performance.now();
      await input.command({ command: 'record' });
      await closed;
      assert.equal(player.killed, true);
      await sleep(duration);
      assert.equal(controller.snapshot().state, duration < 250 ? 'idle' : 'listening');
      if (duration < 250) {
        await input.command({ command: 'release' });
        assert.ok(events.some(event => event.type === 'ui' && event.action === 'continue'));
      } else {
        await input.command({ command: 'cancel' });
      }
      console.log(`Copilot ${duration < 250 ? 'tap' : 'hold'}: native playback stopped in ${Math.round(performance.now() - started - duration)} ms`);
    } finally { input.dispose(); await controller.shutdown(); }
  }
} finally {
  if (originalAudioDriver === undefined) delete process.env.SDL_AUDIODRIVER;
  else process.env.SDL_AUDIODRIVER = originalAudioDriver;
}
