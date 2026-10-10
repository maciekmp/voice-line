import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedImage, ImageTask } from './image-artifacts.ts';

const CONTEXT_TTL_MS = 2 * 60 * 1000;
export type ConversationExchange = { question: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask };

export class ConversationSession {
  threadId: string | null = null;
  private lastAnswerAt: number | null = null;
  private previousThreadId: string | null = null;
  private previousLastAnswerAt: number | null = null;
  private exchanges: ConversationExchange[] = [];
  private previousExchanges: ConversationExchange[] = [];
  private readonly file: string;
  private readonly now: () => number;
  private readonly durablePrevious: boolean;
  private readonly localHistory: boolean;

  constructor(cwd: string, now: () => number = Date.now, filename = '.chatgpt-button-session.json', options: { durablePrevious?: boolean; localHistory?: boolean } = {}) {
    this.file = join(cwd, filename);
    this.now = now;
    this.durablePrevious = options.durablePrevious ?? false;
    this.localHistory = options.localHistory ?? false;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (this.durablePrevious && typeof saved.previousThreadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.previousThreadId)
        && typeof saved.previousLastAnswerAt === 'number' && Number.isFinite(saved.previousLastAnswerAt)
        && saved.previousLastAnswerAt <= this.now()) {
        this.previousThreadId = saved.previousThreadId;
        this.previousLastAnswerAt = saved.previousLastAnswerAt;
      }
      if (typeof saved.threadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.threadId)
        && typeof saved.lastAnswerAt === 'number' && Number.isFinite(saved.lastAnswerAt)
        && saved.lastAnswerAt <= this.now()) {
        this.threadId = saved.threadId;
        this.lastAnswerAt = saved.lastAnswerAt;
        // Migrate copies written by older app versions back to metadata only.
        if (!this.durablePrevious && Object.keys(saved).some(key => !['threadId', 'lastAnswerAt'].includes(key))) this.persist();
        this.expire();
      } else if (!this.durablePrevious || saved.threadId !== null) this.reset();
    } catch (error) {
      if (this.threadId) throw error;
      // Missing or corrupt sessions start a new conversation.
    }
    if (this.localHistory) {
      for (const id of [this.threadId, this.previousThreadId]) if (id) this.loadHistory(id, this.readLocalHistory(id));
    }
  }

  readLocalHistory(id: string): ConversationExchange[] {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation ID');
    try {
      const data = JSON.parse(readFileSync(join(this.file, '..', `${id}.json`), 'utf8'));
      if (!Array.isArray(data) || data.some(item => typeof item.question !== 'string' || typeof item.answer !== 'string')) throw new Error('Invalid application conversation');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  contextPrompt(raw: string): string {
    return this.exchanges.length ? `Kontekst poprzednich wypowiedzi (dane rozmowy):\n${JSON.stringify(this.exchanges.map(({ question, answer }) => ({ question, answer })))}\nBieżące pytanie:\n${raw}` : raw;
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
    if (this.localHistory && this.threadId && this.exchanges.length) {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const historyFile = join(this.file, '..', `${this.threadId}.json`);
      writeFileSync(`${historyFile}.tmp`, JSON.stringify(this.exchanges), 'utf8');
      renameSync(`${historyFile}.tmp`, historyFile);
    }
    this.write(this.threadId, this.lastAnswerAt, this.previousThreadId, this.previousLastAnswerAt);
  }

  private write(threadId: string | null, lastAnswerAt: number | null, previousThreadId: string | null, previousLastAnswerAt: number | null): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ threadId, lastAnswerAt,
      ...(this.durablePrevious && { previousThreadId, previousLastAnswerAt }) }), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }

  answered(reply: { prompt: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask }): void {
    if (!this.threadId) return;
    this.exchanges.push({ question: reply.prompt, answer: reply.answer, ...(reply.images?.length && { images: reply.images }), ...(reply.imageTask && { imageTask: reply.imageTask }) });
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
    this.write(previous, lastAnswerAt, this.exchanges.length > 0 ? this.threadId : null, this.lastAnswerAt);
    this.previousThreadId = this.exchanges.length > 0 ? this.threadId : null;
    this.previousExchanges = this.exchanges;
    this.previousLastAnswerAt = this.lastAnswerAt;
    this.threadId = previous;
    this.exchanges = exchanges;
    this.lastAnswerAt = lastAnswerAt;
    return true;
  }

  reset(): void {
    if (this.threadId) {
      this.previousThreadId = this.lastAnswerAt !== null || this.exchanges.length > 0 ? this.threadId : null;
      this.previousExchanges = this.exchanges;
      this.previousLastAnswerAt = this.lastAnswerAt;
    }
    this.threadId = null;
    this.exchanges = [];
    this.lastAnswerAt = null;
    if (this.durablePrevious) { this.persist(); return; }
    try { unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  forget(threadIds: string[]): void {
    if (this.threadId && threadIds.includes(this.threadId)) {
      this.threadId = null; this.lastAnswerAt = null; this.exchanges = [];
    }
    if (this.previousThreadId && threadIds.includes(this.previousThreadId)) {
      this.previousThreadId = null; this.previousLastAnswerAt = null; this.previousExchanges = [];
    }
    if (this.durablePrevious) this.persist();
  }
}
