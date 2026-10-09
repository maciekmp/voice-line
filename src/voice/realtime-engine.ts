import { BaseVoiceEngine, type ConversationClient, type VoiceCallbacks } from '../voice-engine.ts';
import type { CodexRealtime } from '../codex-realtime.ts';
import { imageRequest } from '../image-artifacts.ts';

export class RealtimeVoiceEngine extends BaseVoiceEngine {
  readonly mode = 'realtime' as const;
  readonly startupDescription = 'Codex realtime (API key)';
  private readonly realtime: ConversationClient & Pick<CodexRealtime, 'respondAudio'>;
  constructor(client: RealtimeVoiceEngine['realtime']) { super(client); this.realtime = client; }
  async respondAudio(wav: string, signal?: AbortSignal, callbacks: VoiceCallbacks = {}) {
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
          requestedImage = final ? imageRequest(text) : null;
          if (requestedImage) { audioController.abort(); return; }
        } else answer = text;
        callbacks.onUpdate?.(speaking ? 'speaking' : 'thinking', {
          exchanges: [...this.currentExchanges, { question, answer }],
        });
      },
      onPlaybackStart: () => { speaking = true; callbacks.onPlaybackStart?.(); },
      onLevel: callbacks.onLevel,
      });
    } catch (error) {
      if (!requestedImage || signal?.aborted || !(error instanceof Error) || error.message !== 'Cancelled') throw error;
      callbacks.onUpdate?.('thinking', { question, answer: '' });
      return await this.generateImage(requestedImage, signal);
    } finally { signal?.removeEventListener('abort', abort); }
  }
}
