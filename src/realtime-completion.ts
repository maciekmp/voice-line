export const CODEX_V2_COMPLETION = Object.freeze({ version: 'v2', transcriptQuietMs: 250 });
type Schedule = (ms: number, callback: () => void) => () => void;
const schedule: Schedule = (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); };

// Experimental v2 exposes final transcript, with a quiet-window fallback. Audio
// after this boundary is an error; it must never produce a committed partial reply.
export class RealtimeCompletionBoundary {
  phase: 'receiving' | 'draining' | 'finished' | 'failed' = 'receiving';
  private finalTranscript = false;
  private cancelTimer?: () => void;
  private readonly complete: () => void;
  private readonly after: Schedule;
  constructor(complete: () => void, after: Schedule = schedule) { this.complete = complete; this.after = after; }
  transcriptFinal(): void {
    if (this.phase !== 'receiving') return;
    this.finalTranscript = true;
    this.waitForQuiet();
  }
  audio(): void {
    if (this.phase !== 'receiving') throw new Error('Realtime audio arrived after the completion boundary');
    if (this.finalTranscript) this.waitForQuiet();
  }
  responseDone(): void {
    if (this.phase !== 'receiving') return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.phase = 'draining';
    this.complete();
  }
  private waitForQuiet(): void {
    this.cancelTimer?.();
    this.cancelTimer = this.after(CODEX_V2_COMPLETION.transcriptQuietMs, () => this.responseDone());
  }
  finish(): void {
    if (this.phase !== 'draining') throw new Error('Realtime completion is unavailable');
    this.phase = 'finished';
  }
  cancel(): void { this.cancelTimer?.(); this.cancelTimer = undefined; this.phase = 'failed'; }
}
