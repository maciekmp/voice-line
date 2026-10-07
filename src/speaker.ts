import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { launch } from './process.ts';
import { AudioLevels, followPlayback } from './audio/levels.ts';

type Worker = ReturnType<typeof launch>;
type ActiveSpeech = {
  worker: Worker;
  playbackStarted: boolean;
  onPlaybackStart?: () => void;
  onLevel?: (level: number) => void;
  levels: AudioLevels;
  stopLevels?: () => void;
  resolve: (started: boolean) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

export class Speaker {
  private readonly script: string;
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private active: ActiveSpeech | null = null;
  private closing = false;

  constructor(script = fileURLToPath(new URL('./speak.ps1', import.meta.url))) { this.script = script; }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    if (this.closing) return Promise.reject(new Error('TTS has shut down'));
    const worker = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script]);
    this.worker = worker;
    let diagnostics = '';
    this.ready = new Promise((resolve, reject) => {
      let initialized = false;
      const fail = (error: Error) => {
        if (this.worker === worker) { this.worker = null; this.ready = null; }
        if (!initialized) { initialized = true; reject(error); }
        if (this.active?.worker === worker) {
          const speech = this.active;
          this.active = null;
          speech.cleanup();
          speech.reject(error);
        }
      };
      worker.stderr.setEncoding('utf8').on('data', chunk => diagnostics = (diagnostics + chunk).slice(-4000));
      createInterface({ input: worker.stdout }).on('line', line => {
        if (line === 'READY') {
          if (!initialized) { initialized = true; resolve(); }
          return;
        }
        const speech = this.active;
        if (!speech || speech.worker !== worker) return;
        if (line.startsWith('AUDIO ')) {
          const [, rate, pcm] = line.split(' ');
          const sampleRate = Number(rate);
          if (Number.isInteger(sampleRate) && sampleRate > 0 && pcm) {
            speech.levels = new AudioLevels(sampleRate);
            speech.levels.push(Buffer.from(pcm, 'base64'));
          }
        } else if (line === 'PLAYBACK_STARTED' && !speech.playbackStarted) {
          speech.playbackStarted = true;
          speech.onPlaybackStart?.();
          speech.stopLevels = followPlayback(speech.levels, speech.onLevel);
        } else if (line === 'DONE') {
          this.active = null;
          speech.cleanup();
          speech.resolve(speech.playbackStarted);
        }
      });
      worker.once('error', error => fail(error));
      worker.once('close', code => fail(new Error(`Windows TTS failed (${code}): ${diagnostics.trim()}`)));
    });
    return this.ready;
  }

  async speak(text: string, signal?: AbortSignal, onPlaybackStart?: () => void, onLevel?: (level: number) => void): Promise<boolean> {
    await this.start();
    if (signal?.aborted) throw new Error('Cancelled');
    if (this.active) throw new Error('TTS is already speaking');
    const worker = this.worker;
    if (!worker) throw new Error('TTS worker is unavailable');
    return new Promise((resolve, reject) => {
      const abort = () => this.stop();
      const speech: ActiveSpeech = {
        worker, playbackStarted: false, onPlaybackStart, onLevel, levels: new AudioLevels(16000), resolve, reject,
        cleanup: () => { signal?.removeEventListener('abort', abort); speech.stopLevels?.(); },
      };
      this.active = speech;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      worker.stdin.write(`${JSON.stringify({ text })}\n`, error => {
        if (error && this.active === speech) this.stop();
      });
    });
  }

  stop(): void {
    const speech = this.active;
    if (!speech) return;
    this.active = null;
    speech.cleanup();
    speech.reject(new Error('Cancelled'));
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    worker?.kill();
    if (!this.closing) void this.start().catch(() => {});
  }

  shutdown(): void {
    this.closing = true;
    const speech = this.active;
    this.active = null;
    speech?.cleanup();
    speech?.reject(new Error('Cancelled'));
    this.worker?.kill();
    this.worker = null;
    this.ready = null;
  }
}
