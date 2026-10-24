// Runs the production IPC handler and controller with deterministic provider results.
import { ApplicationController } from '../../src/application-controller.ts';
import { ApplicationInput } from '../../src/application-input.ts';
import { createWorkerRequestHandler } from '../../src/worker-host.ts';
import type { VoiceEngine } from '../../src/voice-engine.ts';
const engine: VoiceEngine = {
  mode: 'local', startupDescription: 'test worker', currentThreadId: 'test-conversation', currentExchanges: [], canRestorePrevious: false,
  start: async () => {}, startVoice: async () => {}, startPlayback: async () => {},
  stop() {}, cancel() {}, reset() { engine.currentExchanges.length = 0; }, expireConversation() {}, restorePrevious: async () => false,
  async respond(text, signal) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 100);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    if (signal?.aborted) throw new Error('Cancelled');
    const reply = { prompt: text, answer: `worker:${text}` };
    engine.currentExchanges.push({ question: text, answer: reply.answer }); return reply;
  },
  respondAudio: async () => { throw new Error('No test microphone'); },
};
const emit = (value: unknown) => { if (process.connected) process.send?.(value); };
const controller = new ApplicationController({ engine, emit, removeAudio: async () => {}, log: { log() {}, error() {} } });
const input = new ApplicationInput(controller, emit);
let closing: Promise<void> | undefined;
function shutdown() {
  if (!closing) {
    input.dispose();
    closing = controller.shutdown().then(() => { if (process.connected) process.disconnect(); });
  }
  return closing;
}
process.on('message', createWorkerRequestHandler(input, shutdown, emit));
process.once('disconnect', () => { void shutdown(); });
void controller.start();
