import { BaseVoiceEngine, type ConversationClient, type VoiceCallbacks } from '../voice-engine.ts';
import type { Transcriber, SpeechPlayer } from '../conversation-contract.ts';
import { speechText } from '../answer-format.js';

export class LocalVoiceEngine extends BaseVoiceEngine {
  readonly mode = 'local' as const;
  readonly startupDescription: string;
  private readonly stt: Transcriber;
  private readonly speaker: SpeechPlayer;
  constructor(client: ConversationClient, stt: LocalVoiceEngine['stt'], speaker: LocalVoiceEngine['speaker'], tts = 'sapi') {
    super(client); this.stt = stt; this.speaker = speaker;
    this.startupDescription = `Whisper, Codex and TTS (${tts})`;
  }
  override async start(): Promise<void> { await Promise.all([super.start(), this.stt.start(), this.speaker.start()]); }
  override cancel(): void { super.cancel(); this.speaker.stop(); }
  override stop(): void { this.cancel(); super.stop(); this.stt.stop(); this.speaker.shutdown(); }
  async respondAudio(wav: string, signal?: AbortSignal, callbacks: VoiceCallbacks = {}) {
    const check = () => { if (signal?.aborted) throw new Error('Cancelled'); };
    check();
    callbacks.onUpdate?.('transcribing');
    const started = performance.now();
    const raw = await this.stt.transcribe(wav, signal);
    check();
    callbacks.onTiming?.('STT', performance.now() - started);
    if (!raw || !raw.replace(/\*[^*]+\*/g, '').trim()) throw new Error('Nie rozpoznano mowy. Sprawdź mikrofon i spróbuj ponownie.');
    callbacks.onUpdate?.('thinking', { question: raw });
    const turnStarted = performance.now();
    const reply = await this.respond(raw, signal);
    check();
    callbacks.onTiming?.('Codex (cleanup + answer)', performance.now() - turnStarted);
    if (reply.startupMs !== undefined) callbacks.onTiming?.('Codex: request accepted', reply.startupMs);
    if (reply.turnMs !== undefined) callbacks.onTiming?.('Codex: turn to final answer', reply.turnMs);
    callbacks.onUpdate?.('preparing-speech', { question: reply.prompt, answer: reply.answer,
      exchanges: this.currentExchanges });
    const ttsStarted = performance.now();
    await this.speaker.speak(speechText(reply.answer), signal, () => {
      callbacks.onTiming?.('TTS startup to playback', performance.now() - ttsStarted);
      callbacks.onPlaybackStart?.();
    }, callbacks.onLevel);
    check();
    return reply;
  }
}
