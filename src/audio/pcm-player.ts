import { launch } from '../process.ts';
import { AudioLevels, followPlayback } from './levels.ts';
import { decodeRealtimeAudio, type RealtimeAudioChunk } from './realtime-pcm.ts';

/** One FFplay stream per reply; pipe EOF drains all queued audio before idle. */
export class PcmPlayer {
  private child: ReturnType<typeof launch> | null = null;
  private completion: Promise<void> | null = null;
  private cancel?: () => void;
  private sampleRate = 0;
  private channels = 0;
  private queuedBytes = 0;
  private writes = Promise.resolve();
  private levels?: AudioLevels;

  write(audio: RealtimeAudioChunk, onPlayback?: () => void, onLevel?: (level: number) => void, onFailure?: (error: Error) => void): void {
    const pcm = decodeRealtimeAudio(audio);
    if (!pcm.length) return;
    if (!this.child) this.open(audio.sampleRate, audio.numChannels, onPlayback, onLevel, onFailure);
    if (audio.sampleRate !== this.sampleRate || audio.numChannels !== this.channels) throw new Error('Realtime audio format changed during playback');
    if (this.queuedBytes + pcm.length > 32 * 1024 * 1024) throw new Error('Realtime audio queue exceeded 32 MB');
    this.queuedBytes += pcm.length;
    const child = this.child!;
    this.writes = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (this.child !== child) { reject(new Error('Cancelled')); return; }
      child.stdin.write(pcm, error => {
        this.queuedBytes -= pcm.length;
        if (error) reject(error); else resolve();
      });
    }));
    void this.writes.catch(() => {});
    if (this.channels === 1) this.levels!.push(pcm);
    else {
      const mono = Buffer.alloc(pcm.length / 2);
      for (let i = 0; i < mono.length; i += 2) mono.writeInt16LE(Math.round((pcm.readInt16LE(i * 2) + pcm.readInt16LE(i * 2 + 2)) / 2), i);
      this.levels!.push(mono);
    }
  }

  private open(sampleRate: number, channels: number, onPlayback?: () => void, onLevel?: (level: number) => void, onFailure?: (error: Error) => void): void {
    const child = launch(process.env.FFPLAY_BIN ?? 'ffplay.exe', ['-hide_banner', '-loglevel', 'info', '-stats', '-nodisp', '-autoexit',
      '-f', 's16le', '-sample_rate', String(sampleRate), '-ch_layout', channels === 1 ? 'mono' : 'stereo', '-i', 'pipe:0']);
    this.child = child;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.levels = new AudioLevels(sampleRate);
    this.writes = Promise.resolve();
    this.queuedBytes = 0;
    child.stdout.resume();
    this.completion = new Promise((resolve, reject) => {
      let settled = false, started = false, ending = false, diagnostics = '';
      let stopLevels: (() => void) | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopLevels?.();
        if (this.child === child) { this.child = null; this.cancel = undefined; }
        child.kill();
        if (error) { reject(error); onFailure?.(error); } else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Realtime playback timed out')), 180_000);
      this.cancel = () => finish(new Error('Cancelled'));
      child.stdin.on('finish', () => ending = true);
      child.stdin.on('error', error => finish(error));
      child.on('error', error => finish(error));
      child.on('close', code => finish(code === 0 && ending ? undefined : new Error(`FFplay exited (${code}): ${diagnostics}`)));
      child.stderr.on('data', chunk => {
        const status = chunk.toString('utf8');
        diagnostics = (diagnostics + status).slice(-2000);
        if (!started && /\bM-A:\s*-?\d/.test(status)) {
          started = true;
          onPlayback?.();
          stopLevels = followPlayback(this.levels!, onLevel);
        }
      });
    });
    void this.completion.catch(() => {});
  }

  async finish(): Promise<void> {
    if (!this.completion) throw new Error('Realtime returned no audio');
    await this.writes;
    this.child?.stdin.end();
    await this.completion;
  }
  stop(): void { this.cancel?.(); }
}
