// Playback defaults to 40 ms; live recording uses shorter windows.
export class AudioLevels {
  private pending = Buffer.alloc(0);
  readonly values: number[] = [];
  readonly windowMs: number;
  private sampleRate: number;
  constructor(sampleRate: number, windowMs = 40) { this.sampleRate = sampleRate; this.windowMs = windowMs; }
  push(chunk: Buffer): number[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const bytes = Math.round(this.sampleRate * this.windowMs / 1000) * 2;
    const added: number[] = [];
    while (this.pending.length >= bytes) {
      let energy = 0;
      for (let i = 0; i < bytes; i += 2) energy += (this.pending.readInt16LE(i) / 32768) ** 2;
      const rms = Math.sqrt(energy / (bytes / 2));
      const level = Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-9) + 48) / 36));
      added.push(level); this.values.push(level);
      this.pending = this.pending.subarray(bytes);
    }
    return added;
  }
}

export function followPlayback(levels: AudioLevels, callback?: (level: number) => void): () => void {
  const started = performance.now();
  const update = () => callback?.(levels.values[Math.floor((performance.now() - started) / levels.windowMs)] ?? 0);
  update();
  const timer = setInterval(update, levels.windowMs);
  return () => { clearInterval(timer); callback?.(0); };
}
