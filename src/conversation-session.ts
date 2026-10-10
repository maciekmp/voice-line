import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GeneratedImage, ImageTask } from './image-artifacts.ts';

const CONTEXT_TTL_MS = 2 * 60 * 1000;
export type ConversationExchange = { question: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask };
export type LocalHistoryResult =
  | { status: 'loaded'; id: string; exchanges: ConversationExchange[] }
  | { status: 'missing'; id: string }
  | { status: 'corrupt'; id: string; error: Error; preservedFile?: string };

function validExchange(item: any): boolean {
  return !!item && typeof item.question === 'string' && typeof item.answer === 'string'
    && (item.images === undefined || (Array.isArray(item.images) && item.images.every((image: any) =>
      image && typeof image.id === 'string' && /^[a-f0-9]{64}$/.test(image.id) && typeof image.alt === 'string')))
    && (item.imageTask === undefined || (item.imageTask && typeof item.imageTask.threadId === 'string'
      && /^[a-f\d-]{36}$/i.test(item.imageTask.threadId) && typeof item.imageTask.turnId === 'string'
      && /^[a-z\d_-]{1,128}$/i.test(item.imageTask.turnId)));
}

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
  }

  readLocalHistoryResult(id: string): LocalHistoryResult {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation ID');
    let content: string;
    try { content = readFileSync(join(this.file, '..', `${id}.json`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', id };
      throw error;
    }
    try {
      const data = JSON.parse(content);
      if (!Array.isArray(data) || !data.every(validExchange)) throw new Error('Invalid application conversation');
      return { status: 'loaded', id, exchanges: data };
    } catch (error) {
      return { status: 'corrupt', id, error: error as Error };
    }
  }

  readLocalHistory(id: string): ConversationExchange[] {
    const result = this.readLocalHistoryResult(id);
    if (result.status === 'corrupt') throw result.error;
    return result.status === 'loaded' ? result.exchanges : [];
  }

  // Construction reads metadata only. The storage owner explicitly hydrates local data.
  loadLocalHistory(): LocalHistoryResult[] {
    if (!this.localHistory) return [];
    const results: LocalHistoryResult[] = [];
    let changed = false;
    for (const id of new Set([this.threadId, this.previousThreadId])) {
      if (!id) continue;
      const result = this.readLocalHistoryResult(id);
      if (result.status === 'corrupt') {
        const file = join(this.file, '..', `${id}.json`);
        result.preservedFile = `${file}.corrupt-${randomUUID()}`;
        // Retention deletes only <id>.json; keep the original bytes for recovery.
        renameSync(file, result.preservedFile);
      }
      if (result.status === 'loaded' && result.exchanges.length) this.loadHistory(id, result.exchanges);
      else {
        if (this.threadId === id) { this.threadId = null; this.lastAnswerAt = null; this.exchanges = []; }
        if (this.previousThreadId === id) { this.previousThreadId = null; this.previousLastAnswerAt = null; this.previousExchanges = []; }
        changed = true;
      }
      results.push(result);
    }
    // Update references only; never rewrite any conversation during recovery.
    if (changed) this.write(this.threadId, this.lastAnswerAt, this.previousThreadId, this.previousLastAnswerAt);
    return results;
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
