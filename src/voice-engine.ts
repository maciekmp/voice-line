import type { ConversationClient, ConversationExchange, VoiceReply, ConversationCheckpoint } from './conversation-contract.ts';
export type { ConversationClient } from './conversation-contract.ts';
import type { ResponsePhase } from './application-contract.ts';
import { imageRequest } from './image-artifacts.ts';
import { progressCallbacks } from './reply-progress.ts';

export type VoiceCallbacks = {
  onUpdate?: (state: ResponsePhase, text?: { question?: string; answer?: string; exchanges?: ConversationExchange[] }) => void;
  onPlaybackStart?: () => void;
  onLevel?: (level: number) => void;
  onTiming?: (label: string, milliseconds: number) => void;
  onImages?: import('./conversation-contract.ts').ImageProgress;
  onNotice?: (message: string) => void;
  onPlaybackError?: (error: Error) => void;
};
export type VoiceResponseOptions = { playback: boolean; imageId?: string };
export interface VoiceEngine extends ConversationClient {
  readonly mode: 'local' | 'realtime';
  readonly startupDescription: string;
  startVoice(): Promise<void>;
  startPlayback(): Promise<void>;
  respondAudio(wav: string, signal?: AbortSignal, callbacks?: VoiceCallbacks, options?: VoiceResponseOptions): Promise<VoiceReply>;
}

// Conversation ownership remains with Codex; adapters only coordinate voice services.
export abstract class BaseVoiceEngine implements VoiceEngine {
  abstract readonly mode: 'local' | 'realtime';
  abstract readonly startupDescription: string;
  protected readonly client: ConversationClient;
  constructor(client: ConversationClient) { this.client = client; }
  get currentThreadId() { return this.client.currentThreadId; }
  get currentExchanges() { return this.client.currentExchanges; }
  get canRestorePrevious() { return this.client.canRestorePrevious; }
  start() { return this.client.start(); }
  startVoice(): Promise<void> { return Promise.resolve(); }
  startPlayback(): Promise<void> { return Promise.resolve(); }
  stop() { this.client.stop(); }
  cancel() { this.client.cancel(); }
  interruptTurn(checkpoint: ConversationCheckpoint, partial?: VoiceReply) { this.client.interruptTurn?.(checkpoint, partial); }
  reset() { this.cancel(); this.client.reset(); }
  expireConversation() { this.client.expireConversation(); }
  async maintainHistory() { return await this.client.maintainHistory?.() ?? false; }
  restorePrevious(signal?: AbortSignal) { return this.client.restorePrevious(signal); }
  respond(text: string, signal?: AbortSignal, questionSource: import('./conversation-contract.ts').QuestionSource = 'text', imageId?: string, onImages?: import('./conversation-contract.ts').ImageProgress, onText?: import('./conversation-contract.ts').ReplyProgress) {
    const image = imageRequest(text);
    return image ? this.generateImage(image, signal, questionSource, imageId, ...progressCallbacks(onImages, onText))
      : this.client.respond(text, signal, questionSource, imageId, ...progressCallbacks(onImages, onText));
  }
  generateImage(text: string, signal?: AbortSignal, questionSource: import('./conversation-contract.ts').QuestionSource = 'text', imageId?: string, onImages?: import('./conversation-contract.ts').ImageProgress, onText?: import('./conversation-contract.ts').ReplyProgress) {
    if (!this.client.generateImage) return Promise.reject(new Error('ImageGen jest niedostępny.'));
    return this.client.generateImage(text, signal, questionSource, imageId, ...progressCallbacks(onImages, onText));
  }
  abstract respondAudio(wav: string, signal?: AbortSignal, callbacks?: VoiceCallbacks): Promise<VoiceReply>;
}
