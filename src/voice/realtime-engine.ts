import { BaseVoiceEngine, type VoiceCallbacks, type VoiceResponseOptions } from '../voice-engine.ts';
import type { RealtimeConversationClient } from '../conversation-contract.ts';
import { imageRequest } from '../image-artifacts.ts';

export class RealtimeVoiceEngine extends BaseVoiceEngine {
  readonly mode = 'realtime' as const;
  readonly startupDescription = 'Codex realtime (API key)';
  private readonly realtime: RealtimeConversationClient;
  constructor(client: RealtimeVoiceEngine['realtime']) { super(client); this.realtime = client; }
  override async startVoice(): Promise<void> { await this.realtime.startAudio?.(); }
  override async startPlayback(): Promise<void> { await this.realtime.startAudio?.(); }
  async respondAudio(wav: string, signal?: AbortSignal, callbacks: VoiceCallbacks = {}, options: VoiceResponseOptions = { playback: true }) {
    let question = '', answer = '', speaking = false;
    let requestedImage: string | null = null;
    const audioController = new AbortController();
    const abort = () => audioController.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    callbacks.onUpdate?.('thinking');
    try {
      return await this.realtime.respondAudio(wav, audioController.signal, {
      onTranscript: (role, text, final) => {
        if (signal?.aborted) return;
        if (role === 'user') {
          question = text;
          requestedImage = final ? options.imageId ? text : imageRequest(text) : null;
          if (requestedImage) { audioController.abort(); return; }
        } else answer = text;
        callbacks.onUpdate?.(speaking ? 'speaking' : 'thinking', {
          question, answer,
        });
      },
      onPlaybackStart: () => { speaking = true; callbacks.onPlaybackStart?.(); },
      onLevel: callbacks.onLevel,
      });
    } catch (error) {
      if (!requestedImage || signal?.aborted || !(error instanceof Error) || error.message !== 'Cancelled') throw error;
      callbacks.onUpdate?.('thinking', { question, answer: '' });
      return await this.respond(requestedImage, signal, 'voice', options.imageId, callbacks.onImages);
    } finally { signal?.removeEventListener('abort', abort); }
  }
}
