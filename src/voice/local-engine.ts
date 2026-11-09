import { BaseVoiceEngine, type ConversationClient, type VoiceCallbacks, type VoiceResponseOptions } from '../voice-engine.ts';
import type { Transcriber, SpeechPlayer } from '../conversation-contract.ts';
import { StreamingSpeechQueue } from '../streaming-speech.ts';
import { progressCallbacks } from '../reply-progress.ts';

export class LocalVoiceEngine extends BaseVoiceEngine {
  readonly mode = 'local' as const;
  readonly startupDescription: string;
  private readonly stt: Transcriber;
  private readonly speaker: SpeechPlayer;
  private readonly startupErrors: { recording?: string; playback?: string };
  constructor(client: ConversationClient, stt: LocalVoiceEngine['stt'], speaker: LocalVoiceEngine['speaker'], tts = 'sapi',
    startupErrors: { recording?: string; playback?: string } = {}) {
    super(client); this.stt = stt; this.speaker = speaker;
    this.startupErrors = startupErrors;
    this.startupDescription = `Whisper, Codex and TTS (${tts})`;
  }
  override async startVoice(): Promise<void> {
    if (this.startupErrors.recording) throw new Error(this.startupErrors.recording);
    await this.stt.start();
  }
  override async startPlayback(): Promise<void> {
    if (this.startupErrors.playback) throw new Error(this.startupErrors.playback);
    await this.speaker.start();
  }
  override cancel(): void { super.cancel(); this.speaker.stop(); }
  override stop(): void { this.cancel(); super.stop(); this.stt.stop(); this.speaker.shutdown(); }
  async respondAudio(wav: string, signal?: AbortSignal, callbacks: VoiceCallbacks = {}, options: VoiceResponseOptions = { playback: true }) {
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
    const speech = options.playback ? new StreamingSpeechQueue(this.speaker, signal, {
      onStart: () => {
        callbacks.onTiming?.('Codex request to first playback', performance.now() - turnStarted);
        callbacks.onPlaybackStart?.();
      },
      onLevel: callbacks.onLevel,
      onError: callbacks.onPlaybackError,
      onDivergence: () => callbacks.onNotice?.('Końcowa odpowiedź różni się od odczytanego fragmentu. Pełna treść jest widoczna w oknie rozmowy.'),
    }) : undefined;
    const onText: import('../conversation-contract.ts').ReplyProgress | undefined = callbacks.onUpdate || speech ? update => {
      if (signal?.aborted) return;
      callbacks.onUpdate?.(speech?.playbackStarted ? 'speaking' : 'thinking', { question: update.prompt ?? raw, answer: update.answer });
      speech?.update(update.answer);
    } : undefined;
    try {
      const reply = await this.respond(raw, signal, 'voice', options.imageId,
        ...progressCallbacks(callbacks.onImages, onText));
      check();
      callbacks.onTiming?.('Codex (cleanup + answer)', performance.now() - turnStarted);
      if (reply.firstTextMs !== undefined) callbacks.onTiming?.('Codex: first text delta', reply.firstTextMs);
      if (reply.startupMs !== undefined) callbacks.onTiming?.('Codex: request accepted', reply.startupMs);
      if (reply.turnMs !== undefined) callbacks.onTiming?.('Codex: turn to final answer', reply.turnMs);
      if (!speech) return reply;
      callbacks.onUpdate?.(speech.playbackStarted ? 'speaking' : 'preparing-speech', {
        question: reply.prompt, answer: reply.answer, exchanges: this.currentExchanges });
      await speech.finish(reply.answer);
      check();
      return reply;
    } catch (error) {
      speech?.stop();
      await speech?.finish('');
      throw error;
    } finally { speech?.dispose(); }
  }
}
