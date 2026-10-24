import type { ConversationExchange } from './conversation-contract.ts';

export type ApplicationCommand = { command: 'text'; text: string }
  | { command: 'cancel' | 'reset' | 'previous' | 'shutdown' };
export type InputCommand = ApplicationCommand | { command: 'record' | 'release' | 'tap' };
export type ServiceHealth = 'starting' | 'ready' | 'error' | 'stopped';
export type Capability = { state: ServiceHealth | 'disabled'; message?: string };
export type ApplicationCapabilities = { text: Capability; recording: Capability; playback: Capability };
export type ResponsePhase = 'transcribing' | 'thinking' | 'preparing-speech' | 'speaking';
export type ApplicationState = ResponsePhase | 'starting' | 'idle' | 'listening' | 'error';
export type PendingExchange = { id: string; revision: number; question: string; answer: string; questionSource?: import('./conversation-contract.ts').QuestionSource };
export type ConversationView = {
  id: string | null; revision: number; completed: ConversationExchange[]; pending: PendingExchange | null;
};
export type ApplicationSnapshot = {
  type: 'voice'; state: ApplicationState; ready: boolean; health: ServiceHealth; mode: 'local' | 'realtime';
  threadId: string | null; canRestorePrevious: boolean; revision: number; operationId: number | null;
  conversation: ConversationView;
  capabilities: ApplicationCapabilities;
  message?: string;
  generatingImage?: boolean;
  question?: string;
  answer?: string;
  questionSource?: import('./conversation-contract.ts').QuestionSource;
  reset?: boolean;
  restored?: boolean;
  purgeHistory?: boolean;
  exchanges?: ConversationExchange[];
};
export type UiIntent = 'compose' | 'correct' | 'continue' | 'voice-input' | 'text-input';
export type ApplicationEvent = ApplicationSnapshot | { type: 'level'; source: 'listening' | 'speaking'; level: number }
  | { type: 'ui'; action: UiIntent } | { type: 'notice'; message: string; source?: 'shortcut' };

export type InputIntent = 'compose' | 'correct' | 'continue';
export type CommandResult = { accepted: true; operationId: number | null }
  | { accepted: false; reason: 'invalid' | 'unavailable' | 'busy' | 'no-previous' | 'disconnected' | 'timeout' };
export type CommandReceipt = { result: CommandResult; completion: Promise<void> };
export type WorkerRequest = { type: 'request'; requestId: number; command: InputCommand };
export type WorkerResult = { type: 'command-result'; requestId: number; result: CommandResult };

export function parseInputCommand(value: unknown): InputCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as { command?: unknown; text?: unknown };
  if (message.command === 'text') {
    if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 12000) return null;
    return { command: 'text', text: message.text.trim() };
  }
  if (typeof message.command === 'string' && ['record', 'release', 'tap', 'cancel', 'reset', 'previous', 'shutdown'].includes(message.command)) {
    return { command: message.command as Exclude<InputCommand['command'], 'text'> };
  }
  return null;
}
export function parseApplicationCommand(value: unknown): ApplicationCommand | null {
  const message = parseInputCommand(value);
  if (!message || message.command === 'record' || message.command === 'release' || message.command === 'tap') return null;
  return message as ApplicationCommand;
}
