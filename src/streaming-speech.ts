import type { SpeechPlayer } from './conversation-contract.ts';
import { splitAnswer, splitInline, speechText } from './answer-format.js';

function prose(answer: string, final: boolean): string {
  return splitAnswer(answer).filter(part => part.type === 'text').map(part => {
    let text = part.text;
    if (!final) {
      // A fence or inline delimiter may itself arrive one character at a time.
      text = text.replace(/(^|\n) {0,3}~{1,2}$/, '$1');
      const ticks = /`+/g;
      let match: RegExpExecArray | null;
      while ((match = ticks.exec(text))) {
        const close = /`+/g; close.lastIndex = ticks.lastIndex;
        let end: RegExpExecArray | null;
        while ((end = close.exec(text)) && end[0].length !== match[0].length) { /* Match delimiter length. */ }
        if (!end) { text = text.slice(0, match.index); break; }
        ticks.lastIndex = close.lastIndex;
      }
    }
    return splitInline(text).map(part => part.text).join('');
  }).join('\n');
}

type Callbacks = { onStart?: () => void; onLevel?: (level: number) => void; onError?: (error: Error) => void; onDivergence?: () => void };

// One operation owns this queue. Synthesis/playback stays sequential even when
// incoming model text outruns speech, and an abort removes all future chunks.
export class StreamingSpeechQueue {
  private readonly speaker: SpeechPlayer;
  private readonly signal?: AbortSignal;
  private readonly callbacks: Callbacks;
  private readonly segmenter = new Intl.Segmenter('pl', { granularity: 'sentence' });
  private raw = '';
  private projected = '';
  private consumed = 0;
  private chunks: string[] = [];
  private task: Promise<void> | null = null;
  private stopped = false;
  private failed = false;
  private started = false;
  private readonly abort = () => this.stop();

  constructor(speaker: SpeechPlayer, signal?: AbortSignal, callbacks: Callbacks = {}) {
    this.speaker = speaker; this.signal = signal; this.callbacks = callbacks;
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.stop();
  }
  get playbackStarted(): boolean { return this.started; }
  update(answer: string): void {
    if (this.stopped || this.failed) return;
    if (!answer.startsWith(this.raw)) { this.diverge(); return; }
    this.raw = answer;
    this.project(false);
  }
  private project(final: boolean): void {
    const next = prose(this.raw, final);
    if (!next.startsWith(this.projected)) { this.diverge(); return; }
    this.projected = next;
    while (this.consumed < next.length) {
      const remaining = next.slice(this.consumed);
      let length = 0;
      for (const segment of this.segmenter.segment(remaining)) {
        if (/[.!?…][\])"'»”]*\s+$/.test(segment.segment)) { length = segment.segment.length; break; }
      }
      if (!length && final) length = remaining.length;
      if (!length) break;
      this.consumed += length;
      this.enqueue(remaining.slice(0, length));
    }
  }
  private enqueue(text: string): void {
    if (text.trim()) this.chunks.push(text.trim());
    this.schedule();
  }
  private schedule(): void {
    if (this.task || this.stopped || this.failed || !this.chunks.length) return;
    const task = this.drain().finally(() => {
      if (this.task === task) this.task = null;
      this.schedule();
    });
    this.task = task;
  }
  private async drain(): Promise<void> {
    try {
      while (this.chunks.length && !this.stopped && !this.failed && !this.signal?.aborted) {
        let chunk = this.chunks.shift()!;
        while (this.chunks.length && chunk.length + this.chunks[0].length < 350) chunk += ' ' + this.chunks.shift();
        await this.speaker.speak(chunk, this.signal, () => {
          if (this.stopped || this.signal?.aborted) return;
          if (!this.started) { this.started = true; this.callbacks.onStart?.(); }
        }, level => { if (!this.stopped && !this.signal?.aborted) this.callbacks.onLevel?.(level); });
      }
    } catch (error) {
      if (this.stopped || this.signal?.aborted) return;
      this.failed = true; this.chunks = []; this.speaker.stop();
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private diverge(): void {
    const hadSpeech = this.consumed > 0 || this.started;
    this.stop();
    if (hadSpeech) this.callbacks.onDivergence?.();
  }
  async finish(answer: string): Promise<void> {
    if (!this.stopped && !this.failed) {
      if (!answer.startsWith(this.raw)) this.diverge();
      else {
        this.raw = answer; this.project(true);
        if (!this.projected.trim() && !this.stopped) this.enqueue(speechText(answer));
      }
    }
    while (this.task) await this.task;
  }
  stop(): void {
    this.stopped = true; this.chunks = [];
    this.speaker.stop();
  }
  dispose(): void { this.signal?.removeEventListener('abort', this.abort); }
}
