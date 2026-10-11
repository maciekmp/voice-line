import type { ConversationClient, ConversationExchange, VoiceReply, ConversationCheckpoint } from './conversation-contract.ts';
export type { ConversationClient } from './conversation-contract.ts';
import type { ResponsePhase } from './application-contract.ts';
import { imageRequest, explicitImageRequest } from './image-artifacts.ts';

export type VoiceCallbacks = {
  onUpdate?: (state: ResponsePhase, text?: { question?: string; answer?: string; exchanges?: ConversationExchange[] }) => void;
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
  interruptTurn(checkpoint: ConversationCheckpoint, partial?: VoiceReply) { this.client.interruptTurn?.(checkpoint, partial); }
  reset() { this.cancel(); this.client.reset(); }
  expireConversation() { this.client.expireConversation(); }
  async maintainHistory() { return await this.client.maintainHistory?.() ?? false; }
  restorePrevious(signal?: AbortSignal) { return this.client.restorePrevious(signal); }
  respond(text: string, signal?: AbortSignal, questionSource: import('./conversation-contract.ts').QuestionSource = 'text') {
    const image = this.mode === 'local' ? explicitImageRequest(text) : imageRequest(text);
    return image ? this.generateImage(image, signal, questionSource) : this.client.respond(text, signal, questionSource);
  }
  generateImage(text: string, signal?: AbortSignal, questionSource: import('./conversation-contract.ts').QuestionSource = 'text') {
    if (!this.client.generateImage) return Promise.reject(new Error('ImageGen jest niedostępny.'));
    return this.client.generateImage(text, signal, questionSource);
  }
  abstract respondAudio(wav: string, signal?: AbortSignal, callbacks?: VoiceCallbacks): Promise<VoiceReply>;
}
