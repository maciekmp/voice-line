import type { CodexClient, VoiceReply } from './codex.ts';
import type { ConversationExchange } from './conversation-session.ts';
import { imageRequest, explicitImageRequest } from './image-artifacts.ts';

export type ConversationClient = Pick<CodexClient, 'start' | 'stop' | 'cancel' | 'reset' | 'respond'
  | 'currentThreadId' | 'currentExchanges' | 'canRestorePrevious' | 'expireConversation' | 'restorePrevious'>
  & { generateImage?: (text: string, signal?: AbortSignal) => Promise<VoiceReply> };
export type VoiceCallbacks = {
  onUpdate?: (state: string, text?: { question?: string; answer?: string; exchanges?: ConversationExchange[] }) => void;
  onPlaybackStart?: () => void;
  onLevel?: (level: number) => void;
  onTiming?: (label: string, milliseconds: number) => void;
};
export interface VoiceEngine extends ConversationClient {
  readonly mode: 'local' | 'realtime';
  readonly startupDescription: string;
  respondAudio(wav: string, signal?: AbortSignal, callbacks?: VoiceCallbacks): Promise<VoiceReply>;
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
  stop() { this.client.stop(); }
  cancel() { this.client.cancel(); }
  reset() { this.cancel(); this.client.reset(); }
  expireConversation() { this.client.expireConversation(); }
  restorePrevious(signal?: AbortSignal) { return this.client.restorePrevious(signal); }
  respond(text: string, signal?: AbortSignal) {
    const image = this.mode === 'local' ? explicitImageRequest(text) : imageRequest(text);
    return image ? this.generateImage(image, signal) : this.client.respond(text, signal);
  }
  generateImage(text: string, signal?: AbortSignal) {
    if (!this.client.generateImage) return Promise.reject(new Error('ImageGen jest niedostępny.'));
    return this.client.generateImage(text, signal);
  }
  abstract respondAudio(wav: string, signal?: AbortSignal, callbacks?: VoiceCallbacks): Promise<VoiceReply>;
}
