import { createHash } from 'node:crypto';
import { validExchange, copyExchange } from './conversation-model.ts';
import type { ConversationExchange } from './conversation-contract.ts';

export class UnsupportedStorageVersion extends Error {
  constructor(version: unknown) { super(`Unsupported conversation storage version: ${String(version)}`); this.name = 'UnsupportedStorageVersion'; }
}
export type SessionMetadata = {
  version: 2; revision: number; threadId: string | null; lastAnswerAt: number | null;
  previousThreadId?: string | null; previousLastAnswerAt?: number | null;
  receipts?: { [conversationId: string]: { [exchangeId: string]: string } };
  providerThreads?: { [conversationId: string]: string };
  localContextIds?: string[];
};
const validId = (id: unknown) => id === null || (typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id));
const validTime = (time: unknown) => time === null || (typeof time === 'number' && Number.isFinite(time) && time >= 0);
function validReceipts(value: any): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([id, entries]) =>
    id !== 'null' && validId(id) && !!entries && typeof entries === 'object' && !Array.isArray(entries)
    && Object.entries(entries).every(([id, fingerprint]) => /^[a-z\d_-]{1,128}$/i.test(id)
      && typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint)));
}
export function decodeMetadata(value: any): { metadata: SessionMetadata; legacy: boolean } {
  if (value?.version !== undefined && value.version !== 2) throw new UnsupportedStorageVersion(value.version);
  const legacy = value?.version === undefined;
  if (!value || Array.isArray(value) || !validId(value.threadId) || !validTime(value.lastAnswerAt)
    || (value.localContextIds !== undefined && (!Array.isArray(value.localContextIds) || value.localContextIds.some((id: unknown) => id === null || !validId(id))))
    || (value.previousThreadId !== undefined && !validId(value.previousThreadId))
    || (value.previousLastAnswerAt !== undefined && !validTime(value.previousLastAnswerAt))
    || (!legacy && value.receipts !== undefined && !validReceipts(value.receipts))
    || (!legacy && value.providerThreads !== undefined && (!value.providerThreads || typeof value.providerThreads !== 'object'
      || Array.isArray(value.providerThreads) || Object.entries(value.providerThreads).some(([id, thread]) => !validId(id) || thread === null || !validId(thread))))
    || (!legacy && (!Number.isSafeInteger(value.revision) || value.revision < 0))) throw new Error('Invalid conversation metadata');
  return { legacy, metadata: { version: 2, revision: legacy ? 0 : value.revision,
    threadId: value.threadId, lastAnswerAt: value.lastAnswerAt,
    ...(value.localContextIds !== undefined && { localContextIds: value.localContextIds }),
    ...(value.previousThreadId !== undefined && { previousThreadId: value.previousThreadId }),
    ...(value.previousLastAnswerAt !== undefined && { previousLastAnswerAt: value.previousLastAnswerAt }),
    ...(!legacy && value.receipts !== undefined && { receipts: value.receipts }),
    ...(!legacy && value.providerThreads !== undefined && { providerThreads: value.providerThreads }) } };
}
export function stableExchangeId(conversationId: string, source: string): string {
  return createHash('sha256').update(conversationId).update('\0').update(source).digest('hex');
}
export function identifyHistory(id: string, exchanges: ConversationExchange[]): ConversationExchange[] {
  return exchanges.map((exchange, position) => ({ ...copyExchange(exchange),
    id: exchange.id ?? stableExchangeId(id, `legacy:${position}:${JSON.stringify(exchange)}`), revision: exchange.revision ?? 1 }));
}
export function decodeHistory(value: any, id: string): { exchanges: ConversationExchange[]; revision: number; legacy: boolean } {
  const legacy = Array.isArray(value);
  if (!legacy && value?.version !== undefined && value.version !== 2) throw new UnsupportedStorageVersion(value.version);
  if (!legacy && value?.version !== 2) throw new Error('Invalid application conversation');
  const exchanges = legacy ? value : value.exchanges;
  if (!Array.isArray(exchanges) || !exchanges.every(validExchange)
    || (!legacy && (value.id !== id || !Number.isSafeInteger(value.revision) || value.revision < 0
      || exchanges.some((exchange: ConversationExchange) => !exchange.id || exchange.revision === undefined)))) throw new Error('Invalid application conversation');
  const identified = legacy ? identifyHistory(id, exchanges) : exchanges;
  if (new Set(identified.map((exchange: ConversationExchange) => exchange.id)).size !== identified.length) throw new Error('Duplicate conversation exchange ID');
  return { exchanges: identified, revision: legacy ? identified.length : value.revision, legacy };
}
export function encodeHistory(id: string, revision: number, exchanges: ConversationExchange[]): string {
  return JSON.stringify({ version: 2, id, revision, exchanges: identifyHistory(id, exchanges) });
}
