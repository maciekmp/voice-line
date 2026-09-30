import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { launch } from '../process.ts';

function wavHeader(bytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

export class Recorder {
  private capture: ReturnType<typeof launch> | null = null;
  private ready: Promise<void> | null = null;
  private chunks: Buffer[] | null = null;
  private error = '';
  private audioSeconds = 0;
  private audioRmsDbfs = -Infinity;
  private audioPeakDbfs = -Infinity;
  private readonly directory: string;
  private readonly inputArgs: string[];
  constructor(device: string, directory: string, inputArgs?: string[]) {
    this.directory = directory;
    this.inputArgs = inputArgs ?? ['-f', 'dshow', '-i', `audio=${device}`];
  }

  get lastDurationSeconds(): number { return this.audioSeconds; }
  get lastRmsDbfs(): number { return this.audioRmsDbfs; }
  get lastPeakDbfs(): number { return this.audioPeakDbfs; }

  startCapture(): Promise<void> {
    if (this.ready) return this.ready;
    const child = launch(process.env.FFMPEG_BIN ?? 'ffmpeg.exe', ['-hide_banner', '-loglevel', 'error', ...this.inputArgs, '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']);
    this.capture = child;
    this.error = '';
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = null;
        reject(new Error(`FFmpeg microphone capture failed: ${message}`));
      };
      const timer = setTimeout(() => { child.kill(); fail(this.error || 'no audio received within 10 seconds'); }, 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
        if (this.chunks) this.chunks.push(Buffer.from(chunk));
      });
      child.stderr.setEncoding('utf8').on('data', chunk => this.error = (this.error + chunk).slice(-2000));
      child.on('error', error => fail(String(error)));
      child.on('close', code => { if (this.capture === child) { this.capture = null; this.ready = null; } fail(this.error || `exit ${code}`); });
    });
    return this.ready;
  }

  start(): void {
    if (this.chunks) return;
    this.chunks = [];
    if (!this.capture) void this.startCapture().catch(() => {});
  }

  async stop(): Promise<string> {
    const chunks = this.chunks;
    if (!chunks) throw new Error('Recorder is not running');
    this.chunks = null;
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) throw new Error(`No microphone samples recorded. ${this.error}`);
    this.audioSeconds = pcm.length / 32000;
    let energy = 0, peak = 0;
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const value = Math.abs(pcm.readInt16LE(offset));
      energy += value * value;
      peak = Math.max(peak, value);
    }
    const rms = Math.sqrt(energy / (pcm.length / 2));
    this.audioRmsDbfs = rms ? 20 * Math.log10(rms / 32768) : -Infinity;
    this.audioPeakDbfs = peak ? 20 * Math.log10(peak / 32768) : -Infinity;
    const path = join(this.directory, `speech-${randomUUID()}.wav`);
    await writeFile(path, Buffer.concat([wavHeader(pcm.length), pcm]));
    return path;
  }

  cancel(): void { this.chunks = null; }
  shutdown(): void { this.cancel(); this.capture?.kill(); this.capture = null; }
}
