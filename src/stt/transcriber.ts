import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { launch, collect } from '../process.ts';

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class WhisperTranscriber {
  private readonly binary: string;
  private readonly model: string;
  private readonly language: string;
  private readonly serverBinary: string;
  private readonly useCli: boolean;
  private readonly threads: number | null;
  private server: ReturnType<typeof launch> | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private diagnostics = '';

  constructor(binary: string, model: string, language: string) {
    this.binary = binary; this.model = model; this.language = language;
    this.serverBinary = process.env.WHISPER_SERVER_BIN ?? (isAbsolute(binary) ? join(dirname(binary), 'whisper-server.exe') : 'whisper-server.exe');
    this.useCli = process.env.STT_MODE === 'cli';
    const configuredThreads = process.env.WHISPER_THREADS;
    const threads = configuredThreads === undefined ? null : Number(configuredThreads);
    if (threads !== null && (!Number.isInteger(threads) || threads < 1)) throw new Error('WHISPER_THREADS must be a positive integer');
    this.threads = threads;
  }

  start(): Promise<void> {
    if (this.useCli) return Promise.resolve();
    if (!this.startPromise) this.startPromise = this.startServer();
    return this.startPromise;
  }

  private async startServer(): Promise<void> {
    if (!existsSync(this.model)) throw new Error(`Whisper model not found: ${this.model}`);
    if (isAbsolute(this.serverBinary) && !existsSync(this.serverBinary)) throw new Error(`whisper-server.exe not found: ${this.serverBinary}. Set STT_MODE=cli to use the old mode.`);
    this.port = await availablePort();
    const child = launch(this.serverBinary, ['-m', this.model, '-l', this.language, '-nt', '-sns', ...(this.threads ? ['-t', String(this.threads)] : []), '--host', '127.0.0.1', '--port', String(this.port)]);
    this.server = child;
    let failed = false;
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', chunk => this.diagnostics = (this.diagnostics + chunk).slice(-4000));
    child.on('error', error => { failed = true; this.diagnostics = (this.diagnostics + String(error)).slice(-4000); });
    child.on('exit', () => { failed = true; });
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline && !failed) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch { /* Model is still loading. */ }
      await pause(150);
    }
    child.kill();
    throw new Error(`whisper-server.exe did not become ready: ${this.diagnostics}`);
  }

  async transcribe(wav: string, signal?: AbortSignal): Promise<string> {
    if (this.useCli) {
      if (!existsSync(this.model)) throw new Error(`Whisper model not found: ${this.model}`);
      const result = await collect(launch(this.binary, ['-m', this.model, '-f', wav, '-l', this.language, '-nt', '-np', '-sns', ...(this.threads ? ['-t', String(this.threads)] : [])]), signal);
      if (result.code !== 0) throw new Error(`whisper.cpp failed: ${result.stderr.trim()}`);
      return result.stdout.trim();
    }
    await this.start();
    const data = new FormData();
    data.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'speech.wav');
    data.append('response_format', 'json');
    data.append('language', this.language);
    data.append('no_timestamps', 'true');
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: data, signal });
    if (!response.ok) throw new Error(`Whisper server HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('Whisper server returned no text');
    return result.text.trim();
  }

  stop(): void { this.server?.kill(); this.server = null; }
}
