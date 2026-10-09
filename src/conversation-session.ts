import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT_TTL_MS = 2 * 60 * 1000;
export type ConversationExchange = { question: string; answer: string };

export class ConversationSession {
  threadId: string | null = null;
  private lastAnswerAt: number | null = null;
  private previousThreadId: string | null = null;
  private exchanges: ConversationExchange[] = [];
  private previousExchanges: ConversationExchange[] = [];
  private readonly file: string;
  private readonly now: () => number;

  constructor(cwd: string, now: () => number = Date.now) {
    this.file = join(cwd, '.chatgpt-button-session.json');
    this.now = now;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof saved.threadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.threadId)
        && typeof saved.lastAnswerAt === 'number' && Number.isFinite(saved.lastAnswerAt)
        && saved.lastAnswerAt <= this.now()) {
        this.threadId = saved.threadId;
        this.lastAnswerAt = saved.lastAnswerAt;
        // Migrate copies written by older app versions back to metadata only.
        if (Object.keys(saved).some(key => !['threadId', 'lastAnswerAt'].includes(key))) this.persist();
        this.expire();
      } else this.reset();
    } catch (error) {
      if (this.threadId) throw error;
      // Missing or corrupt sessions start a new conversation.
    }
  }

  expire(): void {
    if (this.lastAnswerAt !== null
      && (this.now() - this.lastAnswerAt >= CONTEXT_TTL_MS || this.now() < this.lastAnswerAt)) this.reset();
  }

  get currentExchanges(): ConversationExchange[] { return this.exchanges.map(exchange => ({ ...exchange })); }
  get previousConversationId(): string | null { return this.previousThreadId; }

  loadHistory(threadId: string, exchanges: ConversationExchange[]): void {
    const history = exchanges.map(exchange => ({ ...exchange }));
    if (threadId === this.threadId) {
      this.exchanges = history;
      if (!history.length) this.lastAnswerAt = null;
    } else if (threadId === this.previousThreadId) {
      this.previousExchanges = history;
      if (!history.length) this.previousThreadId = null;
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify({ threadId: this.threadId, lastAnswerAt: this.lastAnswerAt }), 'utf8');
  }

  answered(reply: { prompt: string; answer: string }): void {
    if (!this.threadId) return;
    this.exchanges.push({ question: reply.prompt, answer: reply.answer });
    this.lastAnswerAt = this.now();
    this.persist();
  }

  get canRestorePrevious(): boolean {
    return this.previousThreadId !== null && this.previousExchanges.length > 0;
  }

  restorePrevious(): boolean {
    if (!this.canRestorePrevious) return false;
    const previous = this.previousThreadId;
    const exchanges = this.previousExchanges;
    const lastAnswerAt = this.now();
    writeFileSync(this.file, JSON.stringify({ threadId: previous, lastAnswerAt }), 'utf8');
    this.previousThreadId = this.exchanges.length > 0 ? this.threadId : null;
    this.previousExchanges = this.exchanges;
    this.threadId = previous;
    this.exchanges = exchanges;
    this.lastAnswerAt = lastAnswerAt;
    return true;
  }

  reset(): void {
    if (this.threadId) {
      this.previousThreadId = this.lastAnswerAt !== null || this.exchanges.length > 0 ? this.threadId : null;
      this.previousExchanges = this.exchanges;
    }
    this.threadId = null;
    this.exchanges = [];
    this.lastAnswerAt = null;
    try { unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
