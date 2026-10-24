import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { launch, collect } from '../process.ts';
import { loadWhisperConfig, type WhisperConfig } from '../app-config.ts';

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
  private generation = 0;
  private inferenceAbort = new AbortController();
  protected readonly inferenceTimeoutMs: number = 120_000;

  constructor(binary: string, model: string, language: string, config: WhisperConfig = loadWhisperConfig(undefined, { binary, model, language })) {
    this.binary = binary; this.model = model; this.language = language;
    this.serverBinary = config.serverBinary;
    this.useCli = config.mode === 'cli';
    this.threads = config.threads;
  }

  start(): Promise<void> {
    if (this.useCli) return existsSync(this.model) ? Promise.resolve() : Promise.reject(new Error(`Whisper model not found: ${this.model}`));
    if (!this.startPromise) {
      const startup = this.startServer(this.generation).catch(error => {
        if (this.startPromise === startup) this.startPromise = null;
        throw error;
      });
      this.startPromise = startup;
    }
    return this.startPromise;
  }

  protected launchServer(args: string[]): ReturnType<typeof launch> { return launch(this.serverBinary, args); }
  protected http(url: string, options: RequestInit): Promise<Response> { return fetch(url, options); }

  private async startServer(generation: number): Promise<void> {
    if (!existsSync(this.model)) throw new Error(`Whisper model not found: ${this.model}`);
    if (isAbsolute(this.serverBinary) && !existsSync(this.serverBinary)) throw new Error(`whisper-server.exe not found: ${this.serverBinary}. Set STT_MODE=cli to use the old mode.`);
    const port = await availablePort();
    if (this.generation !== generation) throw new Error('Whisper startup stopped');
    this.port = port;
    this.diagnostics = '';
    this.inferenceAbort = new AbortController();
    const child = this.launchServer(['-m', this.model, '-l', this.language, '-nt', '-sns', ...(this.threads ? ['-t', String(this.threads)] : []), '--host', '127.0.0.1', '--port', String(port)]);
    this.server = child;
    let failed = false;
    child.stdout.resume();
    child.stderr.setEncoding('utf8').on('data', chunk => {
      if (this.server === child) this.diagnostics = (this.diagnostics + chunk).slice(-4000);
    });
    const failure = (error?: Error) => {
      failed = true;
      if (this.server !== child) return;
      if (error) this.diagnostics = (this.diagnostics + String(error)).slice(-4000);
      this.stop();
    };
    child.on('error', failure);
    child.once('exit', () => failure());
    child.once('close', () => failure());
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', failure);
    const deadline = performance.now() + 120_000;
    while (performance.now() < deadline && !failed && this.server === child) {
      try {
        const response = await this.http(`http://127.0.0.1:${port}/`, { signal: AbortSignal.any([AbortSignal.timeout(1000), this.inferenceAbort.signal]) });
        if (response.ok && this.server === child) return;
      } catch { /* Model is still loading. */ }
      await pause(150);
    }
    if (this.server === child) this.stop();
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
    if (signal?.aborted) throw signal.reason;
    if (!this.server) throw new Error('Whisper server is unavailable');
    const data = new FormData();
    data.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'speech.wav');
    data.append('response_format', 'json');
    data.append('language', this.language);
    data.append('no_timestamps', 'true');
    const server = this.server;
    const deadline = AbortSignal.timeout(this.inferenceTimeoutMs);
    let response: Response;
    try {
      response = await this.http(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: data,
        signal: AbortSignal.any([this.inferenceAbort.signal, deadline, ...(signal ? [signal] : [])]) });
    } catch (error) {
      if (deadline.aborted && this.server === server) this.stop();
      throw error;
    }
    if (!response.ok) throw new Error(`Whisper server HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new Error('Whisper server returned no text');
    return result.text.trim();
  }

  stop(): void {
    const child = this.server;
    this.server = null;
    this.startPromise = null;
    this.generation++;
    this.inferenceAbort.abort(new Error('Whisper server stopped'));
    child?.kill();
  }
}
