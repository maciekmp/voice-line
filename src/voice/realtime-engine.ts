import { BaseVoiceEngine, type ConversationClient, type VoiceCallbacks } from '../voice-engine.ts';
import type { CodexRealtime } from '../codex-realtime.ts';

export class RealtimeVoiceEngine extends BaseVoiceEngine {
  readonly mode = 'realtime' as const;
  readonly startupDescription = 'Codex realtime (API key)';
  private readonly realtime: ConversationClient & Pick<CodexRealtime, 'respondAudio'>;
  constructor(client: RealtimeVoiceEngine['realtime']) { super(client); this.realtime = client; }
  respondAudio(wav: string, signal?: AbortSignal, callbacks: VoiceCallbacks = {}) {
    let question = '', answer = '', speaking = false;
    callbacks.onUpdate?.('thinking');
    return this.realtime.respondAudio(wav, signal, {
      onTranscript: (role, text) => {
        if (signal?.aborted) return;
        if (role === 'user') question = text; else answer = text;
        callbacks.onUpdate?.(speaking ? 'speaking' : 'thinking', {
          exchanges: [...this.currentExchanges, { question, answer }],
        });
      },
      onPlaybackStart: () => { speaking = true; callbacks.onPlaybackStart?.(); },
      onLevel: callbacks.onLevel,
    });
  }
}
