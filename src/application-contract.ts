import type { ConversationExchange } from './conversation-contract.ts';

export type ApplicationCommand = { command: 'text'; text: string }
  | { command: 'record' | 'release' | 'cancel' | 'reset' | 'previous' | 'shutdown' };
export type ServiceHealth = 'starting' | 'ready' | 'error' | 'stopped';
export type ResponsePhase = 'transcribing' | 'thinking' | 'preparing-speech' | 'speaking';
export type ApplicationState = ResponsePhase | 'starting' | 'idle' | 'listening' | 'error';
export type PendingExchange = { id: string; revision: number; question: string; answer: string };
export type ConversationView = {
  id: string | null; revision: number; completed: ConversationExchange[]; pending: PendingExchange | null;
};
export type ApplicationSnapshot = {
  type: 'voice'; state: ApplicationState; ready: boolean; health: ServiceHealth; mode: 'local' | 'realtime';
  threadId: string | null; canRestorePrevious: boolean; revision: number; operationId: number | null;
  conversation: ConversationView;
  exchanges?: ConversationExchange[];
  [key: string]: unknown;
};
export type ApplicationEvent = ApplicationSnapshot | { type: 'level'; source: 'listening' | 'speaking'; level: number }
  | { type: 'ui'; action: 'compose' };

export function parseApplicationCommand(value: unknown): ApplicationCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as { command?: unknown; text?: unknown };
  if (message.command === 'text') {
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 12000) return null;
    return { command: 'text', text: message.text.trim() };
  }
  if (typeof message.command === 'string' && ['record', 'release', 'cancel', 'reset', 'previous', 'shutdown'].includes(message.command)) {
    return { command: message.command as Exclude<ApplicationCommand['command'], 'text'> };
  }
  return null;
}
