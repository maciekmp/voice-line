export type GeneratedImage = { id: string; alt: string };
// Serialized legacy field `threadId` identifies the application image conversation.
// Providers resolve CodexThreadId separately; turnId is the remote generation turn.
export type ImageTask = { threadId: string; turnId: string };

export type ConversationExchange = { id?: string; revision?: number; question: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask };
export type VoiceReply = { exchangeId?: string; prompt: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask; startupMs?: number; turnMs?: number };

export interface ConversationClient {
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  reset(): void;
  /** Compatibility name for the selected application ConversationId. */
  readonly currentThreadId: string | null;
  readonly currentExchanges: ConversationExchange[];
  readonly canRestorePrevious: boolean;
  expireConversation(): void;
  restorePrevious(signal?: AbortSignal): Promise<boolean>;
  respond(text: string, signal?: AbortSignal): Promise<VoiceReply>;
  generateImage?(text: string, signal?: AbortSignal): Promise<VoiceReply>;
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
  respondAudio(wav: string, signal?: AbortSignal, callbacks?: RealtimeCallbacks): Promise<VoiceReply>;
}
