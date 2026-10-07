// Fixed 40 ms windows keep IPC bounded and independent of pipe chunk sizes.
export class AudioLevels {
  private pending = Buffer.alloc(0);
  readonly values: number[] = [];
  private sampleRate: number;
  constructor(sampleRate: number) { this.sampleRate = sampleRate; }
  push(chunk: Buffer): number[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const bytes = Math.round(this.sampleRate * .04) * 2;
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
  const update = () => callback?.(levels.values[Math.floor((performance.now() - started) / 40)] ?? 0);
  update();
  const timer = setInterval(update, 40);
  return () => { clearInterval(timer); callback?.(0); };
}
