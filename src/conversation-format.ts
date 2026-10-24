import { createHash } from 'node:crypto';
import { copyExchange } from './conversation-model.ts';
import type { ConversationExchange } from './conversation-contract.ts';
import type { z } from 'zod';
import { legacyMetadataSchema, sessionMetadataSchema, historySchema, legacyHistorySchema } from './conversation-schemas.cjs';

export class UnsupportedStorageVersion extends Error {
  constructor(version: unknown) { super(`Unsupported conversation storage version: ${String(version)}`); this.name = 'UnsupportedStorageVersion'; }
}
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export function decodeMetadata(value: any): { metadata: SessionMetadata; legacy: boolean } {
  if (value?.version !== undefined && value.version !== 2) throw new UnsupportedStorageVersion(value.version);
  const legacy = value?.version === undefined;
  if (legacy) {
    const parsed = legacyMetadataSchema.safeParse(value);
    if (!parsed.success) throw new Error('Invalid conversation metadata');
    return { legacy, metadata: { ...parsed.data, version: 2, revision: 0 } };
  }
  const parsed = sessionMetadataSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid conversation metadata');
  return { legacy, metadata: parsed.data };
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
  const parsed = legacy ? legacyHistorySchema.safeParse(value) : historySchema.safeParse(value);
  if (!parsed.success || (!legacy && value.id !== id)) throw new Error('Invalid application conversation');
  // Preserve extension fields and stable legacy fingerprints during migration.
  const exchanges: ConversationExchange[] = legacy ? value : value.exchanges;
  const identified = legacy ? identifyHistory(id, exchanges) : exchanges;
  if (new Set(identified.map((exchange: ConversationExchange) => exchange.id)).size !== identified.length) throw new Error('Duplicate conversation exchange ID');
  return { exchanges: identified, revision: legacy ? identified.length : value.revision, legacy };
}
export function encodeHistory(id: string, revision: number, exchanges: ConversationExchange[]): string {
  return JSON.stringify({ version: 2, id, revision, exchanges: identifyHistory(id, exchanges) });
}
