import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { localContextPrompt } from './conversation-context.ts';
import { encodeHistory, identifyHistory } from './conversation-format.ts';
import { conversationId, codexThreadId, type ConversationId, type CodexThreadId } from './conversation-identifiers.ts';
import { ConversationRepository } from './conversation-repository.ts';
import type { LocalHistoryResult, TransactionFile } from './conversation-repository.ts';
import type { ConversationExchange, VoiceReply, ConversationCheckpoint } from './conversation-contract.ts';
import { emptySession, copyExchange, answerSession, resetSession, restoreSession, forgetSessions,
  hydrateSession, sessionExpired, canRestore, exchangeFingerprint, type SessionState } from './conversation-model.ts';
export type { ConversationExchange } from './conversation-contract.ts';
export type { LocalHistoryResult } from './conversation-repository.ts';

// Compatibility facade: the pure model plans transitions, the repository commits them.
export class ConversationSession {
  private state = emptySession();
  private readonly now: () => number;
  private readonly durablePrevious: boolean;
  private readonly localHistory: boolean;
  private readonly repository: ConversationRepository;
  private readonly allowMissingHistory: boolean;

  constructor(cwd: string, now: () => number = Date.now, filename = '.session.json', options: { durablePrevious?: boolean; localHistory?: boolean; repository?: ConversationRepository; allowMissingHistory?: boolean } = {}) {
    this.now = now;
    this.durablePrevious = options.durablePrevious ?? false;
    this.localHistory = options.localHistory ?? false;
    this.allowMissingHistory = options.allowMissingHistory ?? false;
    this.repository = options.repository ?? new ConversationRepository(join(cwd, filename));
    let saved: any;
    try { saved = this.repository.load(); }
    catch (error) {
      // Syntax corruption starts a new session; filesystem failures remain actionable.
      if (!(error instanceof SyntaxError)) throw error;
      return;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    if (this.repository.versioned) { this.state.revision = saved.revision; this.state.receipts = saved.receipts ?? {}; this.state.providerThreads = saved.providerThreads ?? {}; }
    this.state.localContextIds = saved.localContextIds ?? [];
    if (this.durablePrevious && typeof saved.previousThreadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.previousThreadId)
      && Number.isFinite(saved.previousLastAnswerAt) && saved.previousLastAnswerAt <= now()) {
      this.state.previousThreadId = saved.previousThreadId;
      this.state.previousLastAnswerAt = saved.previousLastAnswerAt;
    }
    if (typeof saved.threadId === 'string' && /^[a-f\d-]{36}$/i.test(saved.threadId)
      && Number.isFinite(saved.lastAnswerAt) && saved.lastAnswerAt <= now()) {
      this.state.threadId = saved.threadId;
      this.state.lastAnswerAt = saved.lastAnswerAt;
      if (!this.repository.versioned && !this.durablePrevious && Object.keys(saved).some(key => !['threadId', 'lastAnswerAt'].includes(key))) this.write(this.state);
      this.expire();
    } else if (!this.durablePrevious || saved.threadId !== null) this.reset();
  }

  get threadId(): string | null { return this.state.threadId; }
  set threadId(id: string | null) {
    if (id !== null && !/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation ID');
    if (id !== this.state.threadId) this.state = { ...this.state, threadId: id, revision: this.state.revision + 1 };
  }
  get revision(): number { return this.state.revision; }
  get conversationId(): ConversationId | null { return this.threadId ? conversationId(this.threadId) : null; }
  get codexThreadId(): CodexThreadId | null { return this.threadId ? this.providerThreadFor(this.threadId) : null; }
  providerThreadFor(id: string): CodexThreadId { return codexThreadId(this.state.providerThreads[id] ?? id); }
  bindCodexThread(thread: string, id = this.threadId ?? randomUUID()): ConversationId {
    const provider = codexThreadId(thread);
    if (!this.repository.versioned) { this.threadId = provider; return conversationId(provider); }
    const application = conversationId(id);
    const existing = this.state.providerThreads[application];
    if (existing && existing !== provider) throw new Error('Codex returned a different conversation');
    if (this.threadId !== application || existing !== provider) this.state = { ...this.state, threadId: application,
      providerThreads: { ...this.state.providerThreads, [application]: provider }, revision: this.state.revision + 1 };
    return application;
  }
  hasCommittedReply(reply: VoiceReply): boolean {
    if (!reply.exchangeId || !this.threadId || !this.state.receipts[this.threadId]?.[reply.exchangeId]) return false;
    answerSession(this.state, reply, this.now());
    return true;
  }
  captureOperation(): { id: string | null; revision: number } { return { id: this.threadId, revision: this.revision }; }
  matchesOperation(operation: { id: string | null; revision: number }): boolean {
    return operation.id === this.threadId && operation.revision === this.revision;
  }
  get currentExchanges(): ConversationExchange[] { return this.state.exchanges.map(copyExchange); }
  get usesLocalContext(): boolean { return !!this.threadId && this.state.localContextIds.includes(this.threadId); }
  rebindProvider(thread: string, files: TransactionFile[] = []): void {
    if (!this.threadId) throw new Error('Conversation is unavailable');
    const next = { ...this.state, providerThreads: { ...this.state.providerThreads, [this.threadId]: codexThreadId(thread) }, revision: this.revision + 1 };
    this.write(next, false, files); this.state = next;
  }
  interruptTurn(checkpoint: ConversationCheckpoint, partial?: VoiceReply, files: TransactionFile[] = []): void {
    if (!this.threadId) return;
    if (checkpoint.id !== null && checkpoint.id !== this.threadId) throw new Error('Interrupted conversation changed');
    const baseline = checkpoint.exchanges;
    if (baseline.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(this.state.exchanges[index]))) throw new Error('Interrupted conversation history changed');
    const exchanges = baseline.map(copyExchange);
    if (partial) {
      const committed = this.state.exchanges[baseline.length];
      exchanges.push(committed ? copyExchange(committed) : {
        id: partial.exchangeId ?? randomUUID(), revision: 1, question: partial.prompt, answer: partial.answer, interrupted: true,
        ...(partial.questionSource && { questionSource: partial.questionSource }),
        ...(partial.images?.length && { images: partial.images.map(image => ({ ...image })) }),
        ...(partial.inputImages?.length && { inputImages: partial.inputImages.map(image => ({ ...image })) }),
        ...(partial.imageTask && { imageTask: { ...partial.imageTask } }),
      });
    }
    let next = hydrateSession(this.state, this.threadId, exchanges);
    next = { ...next, receipts: { ...next.receipts, [this.threadId]: Object.fromEntries(exchanges.filter(e => e.id).map(e => [e.id!, exchangeFingerprint(e)])) },
      lastAnswerAt: exchanges.length ? (partial ? this.now() : this.state.lastAnswerAt) : null,
      localContextIds: [...new Set([...next.localContextIds, this.threadId])] };
    this.repository.commit(this.metadata(next), { id: this.threadId,
      contents: this.repository.versioned ? encodeHistory(this.threadId, next.revision, exchanges) : JSON.stringify(exchanges) }, files);
    this.state = next;
  }
  get previousConversationId(): string | null { return this.state.previousThreadId; }
  get canRestorePrevious(): boolean { return canRestore(this.state); }

  readLocalHistoryResult(id: string): LocalHistoryResult { return this.repository.loadHistory(id); }
  readLocalHistory(id: string): ConversationExchange[] {
    const result = this.readLocalHistoryResult(id);
    if (result.status === 'corrupt') throw result.error;
    return result.status === 'loaded' ? result.exchanges : [];
  }
  loadLocalHistory(): LocalHistoryResult[] {
    if (!this.localHistory) return [];
    const results: LocalHistoryResult[] = [];
    let next = this.state, changed = false;
    for (const id of new Set([next.threadId, next.previousThreadId])) {
      if (!id) continue;
      const result = this.repository.loadHistory(id);
      if (result.status === 'corrupt') result.preservedFile = this.repository.preserveCorruptHistory(id);
      if (result.status === 'loaded' && result.exchanges.length) next = hydrateSession(next, id, result.exchanges);
      else if (!(result.status === 'missing' && this.allowMissingHistory)) { next = forgetSessions(next, [id]); changed = true; }
      results.push(result);
    }
    if (changed) this.write(next);
    this.state = next;
    return results;
  }
  loadHistory(id: string, exchanges: ConversationExchange[]): void {
    this.state = hydrateSession(this.state, id, this.repository.versioned ? identifyHistory(id, exchanges) : exchanges);
  }
  cacheHistory(id: string, exchanges: ConversationExchange[], files: TransactionFile[] = []): void {
    if (!this.repository.versioned) { this.loadHistory(id, exchanges); return; }
    const next = hydrateSession(this.state, id, identifyHistory(id, exchanges));
    if (next === this.state) return;
    this.repository.commit(this.metadata(next), { id, contents: encodeHistory(id, next.revision, exchanges) }, files);
    this.state = next;
  }
  contextPrompt(raw: string): string {
    return localContextPrompt(this.state.exchanges, raw);
  }
  expire(): void { if (sessionExpired(this.state, this.now())) this.reset(); }

  private metadata(next: SessionState): string {
    return JSON.stringify({ threadId: next.threadId, lastAnswerAt: next.lastAnswerAt,
      ...(next.localContextIds.length && { localContextIds: next.localContextIds }),
      ...(this.repository.versioned && { version: 2, revision: next.revision,
        providerThreads: next.providerThreads,
        receipts: Object.fromEntries(Object.entries(next.receipts).filter(([id]) => id === next.threadId || id === next.previousThreadId)) }),
      ...(this.durablePrevious && { previousThreadId: next.previousThreadId, previousLastAnswerAt: next.previousLastAnswerAt }) });
  }
  private write(next: SessionState, history = false, files: TransactionFile[] = []): void {
    this.repository.commit(this.metadata(next),
      history && this.localHistory && next.threadId && next.exchanges.length
        ? { id: next.threadId, contents: this.repository.versioned ? encodeHistory(next.threadId, next.revision, next.exchanges) : JSON.stringify(next.exchanges) } : undefined, files);
  }
  answered(reply: VoiceReply, files: TransactionFile[] = []): void {
    const next = answerSession(this.state, this.repository.versioned ? { ...reply, exchangeId: reply.exchangeId ?? randomUUID() } : reply, this.now());
    if (next === this.state) return;
    this.write(next, true, files);
    this.state = next;
  }
  restorePrevious(files: TransactionFile[] = []): boolean {
    const next = restoreSession(this.state, this.now());
    if (next === this.state) return false;
    this.write(next, false, files);
    this.state = next;
    return true;
  }
  reset(): void {
    const next = resetSession(this.state);
    if (this.durablePrevious) this.write(next);
    else this.repository.commit(null);
    this.state = next;
  }
  forget(ids: string[]): void {
    const next = forgetSessions(this.state, ids);
    if (this.durablePrevious) this.write(next);
    this.state = next;
  }
}
