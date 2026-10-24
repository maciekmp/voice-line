import type { z } from 'zod';
import type { questionSourceSchema, generatedImageSchema, imageTaskSchema, exchangeSchema } from './conversation-schemas.cjs';

export type QuestionSource = z.infer<typeof questionSourceSchema>;
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
// Serialized legacy field `threadId` identifies the application image conversation.
// Providers resolve CodexThreadId separately; turnId is the remote generation turn.
export type ImageTask = z.infer<typeof imageTaskSchema>;

export type ConversationExchange = z.infer<typeof exchangeSchema>;
export type VoiceReply = { exchangeId?: string; interrupted?: boolean; questionSource?: QuestionSource; prompt: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask; startupMs?: number; turnMs?: number };
export type ConversationCheckpoint = { id: string | null; exchanges: ConversationExchange[] };

export interface ConversationClient {
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  interruptTurn?(checkpoint: ConversationCheckpoint, partial?: VoiceReply): void;
  reset(): void;
  /** Compatibility name for the selected application ConversationId. */
  readonly currentThreadId: string | null;
  readonly currentExchanges: ConversationExchange[];
  readonly canRestorePrevious: boolean;
  expireConversation(): void;
  restorePrevious(signal?: AbortSignal): Promise<boolean>;
  respond(text: string, signal?: AbortSignal, questionSource?: QuestionSource): Promise<VoiceReply>;
  generateImage?(text: string, signal?: AbortSignal, questionSource?: QuestionSource): Promise<VoiceReply>;
  maintainHistory?(): Promise<boolean>;
}

export interface Transcriber {
  start(): Promise<void>;
  stop(): void;
  transcribe(wav: string, signal?: AbortSignal): Promise<string>;
}

export interface SpeechPlayer {
  start(): Promise<void>;
  stop(): void;
  shutdown(): void;
  speak(text: string, signal?: AbortSignal, onPlaybackStart?: () => void, onLevel?: (level: number) => void): Promise<boolean>;
}

export type RealtimeCallbacks = {
  onTranscript?: (role: 'user' | 'assistant', text: string, final?: boolean) => void;
  onPlaybackStart?: () => void;
  onLevel?: (level: number) => void;
};

export interface RealtimeConversationClient extends ConversationClient {
  startAudio?(): Promise<void>;
  respondAudio(wav: string, signal?: AbortSignal, callbacks?: RealtimeCallbacks): Promise<VoiceReply>;
}
