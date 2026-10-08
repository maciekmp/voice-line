import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CONTEXT_TTL_MS = 2 * 60 * 1000;

export class ConversationSession {
  threadId: string | null = null;
  private lastAnswerAt: number | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(cwd: string, now: () => number = Date.now) {
    this.file = join(cwd, '.chatgpt-button-session.json');
    this.now = now;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof saved.threadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.threadId)
        && typeof saved.lastAnswerAt === 'number' && Number.isFinite(saved.lastAnswerAt)) {
        this.threadId = saved.threadId;
        this.lastAnswerAt = saved.lastAnswerAt;
        this.expire();
      } else this.reset();
    } catch { /* Missing or corrupt sessions start a new conversation. */ }
  }

  expire(): void {
    if (this.lastAnswerAt !== null
      && (this.now() - this.lastAnswerAt >= CONTEXT_TTL_MS || this.now() < this.lastAnswerAt)) this.reset();
  }

  answered(): void {
    if (!this.threadId) return;
    this.lastAnswerAt = this.now();
    writeFileSync(this.file, JSON.stringify({ threadId: this.threadId, lastAnswerAt: this.lastAnswerAt }), 'utf8');
  }

  reset(): void {
    this.threadId = null;
    this.lastAnswerAt = null;
    try { unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
