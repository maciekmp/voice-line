import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startKeyboard } from './keyboard/copilot-key.ts';
import { Recorder } from './audio/recorder.ts';
import { createVoiceEngine } from './voice/create-engine.ts';
import { loadAppConfig } from './app-config.ts';
import { ApplicationController } from './application-controller.ts';

// The legacy diagnostic flag delegates to the isolated keyboard entrypoint.
if (process.argv.includes('--debug-keys')) {
  await import('../scripts/diagnose-keys.ts');
} else {
  const config = (() => {
    try { return loadAppConfig(); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
  })();
  if (!config.microphone) {
    console.error('Set MIC_DEVICE. Run npm run diagnose:devices and npm run diagnose:keys first.');
    process.exit(1);
  }
  const engine = (() => {
    try { return createVoiceEngine(resolve('.'), true, config); }
    catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
  })();
  const desktop = process.argv.includes('--desktop');
  const controller = new ApplicationController({ engine,
    recorder: new Recorder(config.microphone, tmpdir(), undefined, config.ffmpeg),
    desktop, key: config.copilotVk, saveAudio: config.saveAudio, debug: process.argv.includes('--debug'),
    removeAudio: wav => unlink(wav),
    emit(event) {
      if (desktop && process.connected) process.send?.(event, error => { if (error) void shutdown(); });
    },
  });
  const keyboard = startKeyboard(event => controller.handleKey(event), message => controller.inputError(message), { suppressVk: config.copilotVk });
  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (!closing) closing = Promise.allSettled([controller.shutdown(), keyboard.stop()]).then(() => { process.exit(0); });
    return closing;
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  if (desktop) {
    process.once('disconnect', () => { void shutdown(); });
    process.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && (message as { command?: unknown }).command === 'shutdown') void shutdown();
      else void controller.command(message);
    });
  }
  void controller.start();
}
