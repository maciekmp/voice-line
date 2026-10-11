import type { ConversationExchange, VoiceReply } from './conversation-contract.ts';
import { createHash } from 'node:crypto';

export const CONTEXT_TTL_MS = 2 * 60 * 1000;
export type SessionState = {
  threadId: string | null;
  lastAnswerAt: number | null;
  previousThreadId: string | null;
  previousLastAnswerAt: number | null;
  exchanges: ConversationExchange[];
  previousExchanges: ConversationExchange[];
  revision: number;
  providerThreads: { [conversationId: string]: string };
  localContextIds: string[];
  receipts: { [conversationId: string]: { [exchangeId: string]: string } };
};
export function emptySession(): SessionState {
  return { threadId: null, lastAnswerAt: null, previousThreadId: null, previousLastAnswerAt: null,
    exchanges: [], previousExchanges: [], revision: 0, receipts: {}, providerThreads: {}, localContextIds: [] };
}
export function exchangeFingerprint(exchange: ConversationExchange): string {
  return createHash('sha256').update(JSON.stringify([exchange.question, exchange.answer,
    (exchange.images ?? []).map(image => [image.id, image.alt]),
    exchange.imageTask ? [exchange.imageTask.threadId, exchange.imageTask.turnId] : null,
    ...(exchange.interrupted ? ['interrupted'] : [])])).digest('hex');
}
export function copyExchange(exchange: ConversationExchange): ConversationExchange {
  return { ...exchange, ...(exchange.images && { images: exchange.images.map(image => ({ ...image })) }),
    ...(exchange.imageTask && { imageTask: { ...exchange.imageTask } }) };
}
export function validExchange(item: any): item is ConversationExchange {
  return !!item && typeof item.question === 'string' && typeof item.answer === 'string'
    && (item.interrupted === undefined || typeof item.interrupted === 'boolean')
    && (item.id === undefined || (typeof item.id === 'string' && /^[a-z\d_-]{1,128}$/i.test(item.id)))
    && (item.revision === undefined || (Number.isSafeInteger(item.revision) && item.revision >= 1))
    && (item.images === undefined || (Array.isArray(item.images) && item.images.every((image: any) =>
      image && typeof image.id === 'string' && /^[a-f0-9]{64}$/.test(image.id) && typeof image.alt === 'string')))
    && (item.imageTask === undefined || (item.imageTask && typeof item.imageTask.threadId === 'string'
      && /^[a-f\d-]{36}$/i.test(item.imageTask.threadId) && typeof item.imageTask.turnId === 'string'
      && /^[a-z\d_-]{1,128}$/i.test(item.imageTask.turnId)));
}
export function answerSession(state: SessionState, reply: VoiceReply, now: number): SessionState {
  if (!state.threadId) return state;
  const exchange = { question: reply.prompt, answer: reply.answer,
    ...(reply.interrupted && { interrupted: true }),
    ...(reply.exchangeId && { id: reply.exchangeId, revision: 1 }),
    ...(reply.images?.length && { images: reply.images }), ...(reply.imageTask && { imageTask: reply.imageTask }) };
  if (!validExchange(exchange)) throw new Error('Invalid conversation exchange');
  const fingerprint = exchangeFingerprint(exchange);
  const receipt = reply.exchangeId && state.receipts[state.threadId]?.[reply.exchangeId];
  if (receipt) {
    if (receipt !== fingerprint) throw new Error('Conflicting conversation exchange ID');
    return state;
  }
  const existing = reply.exchangeId && state.exchanges.find(exchange => exchange.id === reply.exchangeId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(exchange)) {
      // Compare fields in a fixed order; hydrated objects may have a different key order.
      const canonical = (entry: ConversationExchange) => JSON.stringify([entry.question, entry.answer, entry.images ?? [], entry.imageTask ?? null]);
      if (canonical(existing) !== canonical(exchange)) throw new Error('Conflicting conversation exchange ID');
    }
    return state;
  }
  return { ...state, exchanges: [...state.exchanges, copyExchange(exchange)], lastAnswerAt: now, revision: state.revision + 1,
    receipts: reply.exchangeId ? { ...state.receipts, [state.threadId]: { ...state.receipts[state.threadId], [reply.exchangeId]: fingerprint } } : state.receipts };
}
export function resetSession(state: SessionState): SessionState {
  const populated = state.lastAnswerAt !== null || state.exchanges.length > 0;
  return { ...state, threadId: null, lastAnswerAt: null, exchanges: [], revision: state.revision + 1,
    ...(state.threadId && { previousThreadId: populated ? state.threadId : null,
      previousLastAnswerAt: state.lastAnswerAt, previousExchanges: state.exchanges }) };
}
export function canRestore(state: SessionState): boolean {
  return state.previousThreadId !== null && state.previousExchanges.length > 0;
}
export function restoreSession(state: SessionState, now: number): SessionState {
  if (!canRestore(state)) return state;
  return { ...state, threadId: state.previousThreadId, exchanges: state.previousExchanges, lastAnswerAt: now,
    previousThreadId: state.exchanges.length ? state.threadId : null,
    previousLastAnswerAt: state.lastAnswerAt, previousExchanges: state.exchanges, revision: state.revision + 1 };
}
export function forgetSessions(state: SessionState, ids: readonly string[]): SessionState {
  state = { ...state, localContextIds: state.localContextIds.filter(id => !ids.includes(id)) };
  return { ...state, revision: state.revision + 1, receipts: Object.fromEntries(Object.entries(state.receipts).filter(([id]) => !ids.includes(id))),
    providerThreads: Object.fromEntries(Object.entries(state.providerThreads).filter(([id]) => !ids.includes(id))),
    ...(state.threadId && ids.includes(state.threadId) && { threadId: null, lastAnswerAt: null, exchanges: [] }),
    ...(state.previousThreadId && ids.includes(state.previousThreadId) && {
      previousThreadId: null, previousLastAnswerAt: null, previousExchanges: [] }) };
}
export function hydrateSession(state: SessionState, id: string, history: ConversationExchange[]): SessionState {
  if (!history.every(validExchange)) throw new Error('Invalid application conversation');
  const exchanges = history.map(copyExchange);
  const receipts = { ...state.receipts, [id]: { ...state.receipts[id], ...Object.fromEntries(exchanges.filter(exchange => exchange.id).map(exchange => [exchange.id!, exchangeFingerprint(exchange)])) } };
  if (id === state.threadId) return { ...state, exchanges, receipts, revision: state.revision + 1, ...(exchanges.length === 0 && { lastAnswerAt: null }) };
  if (id === state.previousThreadId) return { ...state, previousExchanges: exchanges, receipts, revision: state.revision + 1,
    ...(exchanges.length === 0 && { previousThreadId: null }) };
  return state;
}
export function sessionExpired(state: SessionState, now: number): boolean {
  return state.lastAnswerAt !== null && (now - state.lastAnswerAt >= CONTEXT_TTL_MS || now < state.lastAnswerAt);
}
