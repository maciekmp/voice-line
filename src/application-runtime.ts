import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplicationController } from './application-controller.ts';
import { ApplicationInput } from './application-input.ts';
import type { ApplicationEvent } from './application-contract.ts';
import { Recorder } from './audio/recorder.ts';
import { startKeyboard } from './keyboard/copilot-key.ts';
import { createVoiceEngine } from './voice/create-engine.ts';
import { loadAppConfig } from './app-config.ts';
import { verifyImportedImage } from './imported-image.ts';
import { storageCoordinator } from './storage-coordinator.ts';

// Shared composition root. Hosts supply presentation, process signals and transport.
// Resource validation happens per service so missing audio never prevents typing.
export function createApplicationRuntime(emit: (event: ApplicationEvent) => void,
  options: { debug?: boolean; log?: Pick<Console, 'log' | 'error'>; keyboard?: boolean; voice?: boolean } = {}) {
  const config = loadAppConfig(undefined, false, true);
  const controller = new ApplicationController({
    engine: createVoiceEngine(resolve('.'), false, config, options.debug
      ? (source, line) => (options.log ?? console).log(`[codex:${source}:raw] ${line}`) : undefined),
    recorder: options.voice !== false && config.microphone ? new Recorder(config.microphone, tmpdir(), undefined, config.ffmpeg) : undefined,
    playback: options.voice,
    recordingUnavailableMessage: options.voice === false ? 'Nagrywanie jest wyłączone w trybie potokowym.' : undefined,
    emit, removeAudio: wav => unlink(wav), saveAudio: config.saveAudio, debug: options.debug, log: options.log,
    verifyImage: image => verifyImportedImage(config.dataDirectory, image),
    retainImage: id => storageCoordinator(config.dataDirectory).lease(`input-image:${id}`),
  });
  const input = new ApplicationInput(controller, emit, { key: config.copilotVk });
  let keyboard: ReturnType<typeof startKeyboard> | undefined;
  let closing: Promise<void> | undefined;
  let started: Promise<void> | undefined;
  return {
    snapshot: () => controller.snapshot(),
    dispatch: (value: unknown) => input.dispatch(value),
    start() {
      if (closing) return Promise.resolve();
      if (!started) {
        if (config.serviceErrors?.shortcut) emit({ type: 'notice', source: 'shortcut', message: `Skrót Copilot jest niedostępny: ${config.serviceErrors.shortcut}` });
        else if (options.keyboard !== false) {
          keyboard = startKeyboard(event => input.handleKey(event), () => {
            emit({ type: 'notice', source: 'shortcut', message: 'Skrót Copilot jest niedostępny. Możesz pisać; ponów uruchomienie usług, aby przywrócić skrót.' });
          }, { suppressVk: config.copilotVk });
        }
        started = controller.start();
      }
      return started;
    },
    shutdown() {
      if (!closing) {
        input.dispose();
        closing = Promise.allSettled([controller.shutdown(), keyboard?.stop()]).then(() => {});
      }
      return closing;
    },
  };
}
export type ApplicationRuntime = ReturnType<typeof createApplicationRuntime>;
