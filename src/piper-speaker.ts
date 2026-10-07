import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launch } from './process.ts';
import { AudioLevels, followPlayback } from './audio/levels.ts';

type Process = ReturnType<typeof launch>;

export class PiperSpeaker {
  private readonly binary: string;
  private readonly model: string;
  private readonly player: string;
  private sampleRate = 0;
  private ready: Promise<void> | null = null;
  private active: { piper: Process; player: Process; cancel: () => void } | null = null;

  constructor(
    binary = process.env.PIPER_BIN ?? 'piper.exe',
    model = process.env.PIPER_MODEL ?? '',
    player = process.env.FFPLAY_BIN ?? 'ffplay.exe',
  ) {
    this.binary = /[\\/]/.test(binary) ? resolve(binary) : binary;
    this.model = model ? resolve(model) : '';
    this.player = /[\\/]/.test(player) ? resolve(player) : player;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      if (!this.model) throw new Error('Set PIPER_MODEL in .env for TTS_MODE=piper.');
      await access(this.model);
      const config = JSON.parse(await readFile(`${this.model}.json`, 'utf8'));
      const sampleRate = Number(config.audio?.sample_rate);
      if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('Piper voice config has no valid audio.sample_rate.');
      this.sampleRate = sampleRate;
    })().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  async speak(text: string, signal?: AbortSignal, onPlaybackStart?: () => void, onLevel?: (level: number) => void): Promise<boolean> {
    await this.start();
    if (signal?.aborted) throw new Error('Cancelled');
    if (this.active) throw new Error('TTS is already speaking');

    const piper = launch(this.binary, ['--model', this.model, '--output_raw']);
    const player = launch(this.player, [
      '-hide_banner', '-loglevel', 'info', '-stats', '-nodisp', '-autoexit',
      '-f', 's16le', '-ar', String(this.sampleRate), '-i', 'pipe:0',
    ]);
    const levels = new AudioLevels(this.sampleRate);
    piper.stdout.on('data', (chunk: Buffer) => levels.push(chunk));
    piper.stdout.pipe(player.stdin);

    return new Promise((resolveSpeech, rejectSpeech) => {
      let settled = false;
      let stopLevels: (() => void) | undefined;
      let piperDone = false;
      let playerDone = false;
      let piperCode = 1;
      let playerCode = 1;
      let playbackStarted = false;
      let diagnostics = '';
      const abort = () => finish(new Error('Cancelled'));
      const active = { piper, player, cancel: abort };
      this.active = active;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        stopLevels?.();
        if (this.active === active) this.active = null;
        signal?.removeEventListener('abort', abort);
        piper.stdout.unpipe(player.stdin);
        piper.kill();
        player.kill();
        if (error) rejectSpeech(error);
        else resolveSpeech(playbackStarted);
      };
      const checkDone = () => {
        if (!piperDone || !playerDone) return;
        if (piperCode !== 0 || playerCode !== 0) finish(new Error(`Piper TTS failed (Piper ${piperCode}, FFplay ${playerCode}): ${diagnostics.trim()}`));
        else finish();
      };
      const capture = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-4000); };
      piper.stderr.on('data', capture);
      piper.stdin.on('error', error => finish(error));
      player.stdin.on('error', error => finish(error));
      player.stderr.on('data', (chunk: Buffer) => {
        const status = chunk.toString('utf8');
        capture(chunk);
        // FFplay prints M-A after its audio clock starts. This is an approximate playback marker.
        if (!playbackStarted && /\bM-A:\s*-?\d/.test(status)) {
          playbackStarted = true;
          onPlaybackStart?.();
          stopLevels = followPlayback(levels, onLevel);
        }
      });
      piper.on('error', error => finish(error));
      player.on('error', error => finish(error));
      piper.on('close', code => { piperDone = true; piperCode = code ?? 1; checkDone(); });
      player.on('close', code => { playerDone = true; playerCode = code ?? 1; checkDone(); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      piper.stdin.end(`${text.replace(/[\r\n]+/g, ' ')}\n`);
    });
  }

  stop(): void { this.active?.cancel(); }
  shutdown(): void { this.stop(); }
}
