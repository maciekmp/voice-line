import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { launch, collect } from './process.ts';

export class Speaker {
  private child: ReturnType<typeof launch> | null = null;
  stop(): void { this.child?.kill(); this.child = null; }
  async speak(text: string, signal?: AbortSignal, onReady?: () => void): Promise<void> {
    this.stop();
    const script = fileURLToPath(new URL('./speak.ps1', import.meta.url));
    const child = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
    this.child = child;
    createInterface({ input: child.stdout }).on('line', line => { if (line === 'READY') onReady?.(); });
    const result = collect(child, signal);
    child.stdin.end(text);
    try {
      const outcome = await result;
      if (outcome.code !== 0) throw new Error(`Windows TTS failed: ${outcome.stderr.trim()}`);
    } finally { if (this.child === child) this.child = null; }
  }
}
