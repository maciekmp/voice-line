import type { VoiceEngine, VoiceCallbacks } from './voice-engine.ts';
import type { VoiceReply, ConversationExchange, ConversationCheckpoint } from './conversation-contract.ts';
import { parseApplicationCommand, type ApplicationEvent, type ApplicationSnapshot, type ServiceHealth, type ApplicationState, type PendingExchange } from './application-contract.ts';
import { createCopilotGesture } from './keyboard/copilot-gesture.ts';
import type { KeyEvent } from './keyboard/copilot-key.ts';
import { imageRequest } from './image-artifacts.ts';
import { codexErrorMessage } from './codex-error.ts';

export interface AudioRecorder {
  startCapture(): Promise<void>;
  start(): void;
  stop(): Promise<string>;
  cancel(): void;
  shutdown(): void;
  onLevel?: (level: number) => void;
  readonly lastDurationSeconds: number;
  readonly lastRmsDbfs: number;
  readonly lastPeakDbfs: number;
}
export type ControllerClock = {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void;
  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval> | undefined): void;
};
type Operation = { id: number; revision: number; generation: number; controller: AbortController; checkpoint: ConversationCheckpoint; playbackStarted: boolean };
type Options = {
  engine: VoiceEngine; recorder: AudioRecorder; emit: (event: ApplicationEvent) => void;
  removeAudio: (wav: string) => Promise<void>; desktop?: boolean; key?: number; saveAudio?: boolean; debug?: boolean;
  clock?: ControllerClock; log?: Pick<Console, 'log' | 'error'>; operationTimeoutMs?: number; shutdownTimeoutMs?: number;
};

export class ApplicationController {
  private readonly options: Options;
  private readonly clock: ControllerClock;
  private readonly log: Pick<Console, 'log' | 'error'>;
  private readonly gesture: ReturnType<typeof createCopilotGesture>;
  private readonly pressed = new Set<number>();
  private health: ServiceHealth = 'starting';
  private phase: ApplicationState = 'starting';
  private held = false;
  private pressIntent: 'compose' | 'correct' | 'continue' = 'compose';
  private pressUnavailable = false;
  private generation = 0;
  private revision = 0;
  private nextId = 0;
  private current: Operation | null = null;
  private recordingStartedAt = 0;
  private startup: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintaining = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly tasks = new Set<Promise<void>>();
  private completedExchanges: ConversationExchange[] = [];
  private pendingExchange: PendingExchange | null = null;
  private pendingRevision = 0;
  private conversationRevision = 0;

  constructor(options: Options) {
    this.options = options;
    this.clock = options.clock ?? { now: () => performance.now(), setTimeout, clearTimeout, setInterval, clearInterval };
    this.log = options.log ?? console;
    options.recorder.onLevel = level => this.level('listening', level);
    this.gesture = createCopilotGesture({
      down: () => {
        this.pressUnavailable = this.health !== 'ready';
        this.pressIntent = this.interruptForInput();
        if (!this.pressUnavailable) this.beginRecording(false);
      }, hold: () => {
        if (this.pressUnavailable) this.options.emit({ type: 'ui', action: 'compose' });
        else this.confirmRecording();
      },
      tap: () => {
        if (this.held) { options.recorder.cancel(); this.held = false; this.publish('idle'); }
        options.emit({ type: 'ui', action: this.pressIntent });
      },
      release: () => { void this.releaseRecording(); },
    }, 250, this.clock, () => this.clock.now());
  }

  snapshot(): ApplicationSnapshot {
    const engine = this.options.engine;
    return { type: 'voice', state: this.phase, ready: this.health === 'ready', health: this.health,
      mode: engine.mode, threadId: engine.currentThreadId, canRestorePrevious: engine.canRestorePrevious,
      revision: this.revision, operationId: this.current?.id ?? null,
      conversation: { id: engine.currentThreadId, revision: this.conversationRevision,
        completed: this.completedExchanges, pending: this.pendingExchange } };
  }
  private publish(state: ApplicationState, extra: Record<string, unknown> = {}): void {
    if (this.health === 'stopped') return;
    if (Array.isArray(extra.exchanges)) {
      this.completedExchanges = structuredClone(extra.exchanges as ConversationExchange[]);
      this.pendingExchange = null;
      this.conversationRevision++;
    } else {
      if (extra.reset) {
        this.completedExchanges = [];
        this.pendingExchange = null;
        this.conversationRevision++;
      }
      if ('question' in extra || 'answer' in extra) {
        this.pendingExchange = {
          id: `operation:${this.current?.id ?? `recording:${this.generation}`}`,
          revision: ++this.pendingRevision,
          question: typeof extra.question === 'string' ? extra.question : this.pendingExchange?.question ?? '',
          answer: typeof extra.answer === 'string' ? extra.answer : this.pendingExchange?.answer ?? '',
        };
      }
    }
    this.phase = state;
    this.options.emit({ ...this.snapshot(), ...extra });
  }
  private level(source: 'listening' | 'speaking', level: number): void {
    if (this.health !== 'stopped' && Number.isFinite(level)) this.options.emit({ type: 'level', source, level: Math.min(1, Math.max(0, level)) });
  }
  private timing(label: string, milliseconds?: number): void {
    if (this.options.debug && milliseconds !== undefined) this.log.log(`[time] ${label}: ${(milliseconds / 1000).toFixed(2)} s`);
  }
  start(): Promise<void> {
    if (this.health === 'stopped') return Promise.reject(new Error('Application has stopped'));
    if (!this.startup) {
      this.publish('starting');
      this.log.log(`Starting microphone and ${this.options.engine.startupDescription}...`);
      this.startup = Promise.all([this.options.engine.start(), this.options.recorder.startCapture()]).then(() => {
        if (this.health === 'stopped') return;
        this.health = 'ready';
        this.publish('idle', { exchanges: this.options.engine.currentExchanges });
        this.maintenanceTimer = this.clock.setInterval(() => { void this.maintainHistory(); }, 60_000);
        this.maintenanceTimer.unref?.();
        this.log.log(`Ready. Hold Copilot (vk=${this.options.key ?? 134}); Ctrl+Shift+N resets; Ctrl+C exits.`);
      }).catch(error => {
        if (this.health === 'stopped') return;
        this.health = 'error';
        this.log.error(error);
        this.publish('error', { message: codexErrorMessage(error, 'Nie udało się uruchomić usług. Sprawdź mikrofon, Whisper, Codex i ustawienia .env, a następnie uruchom usługi ponownie.') });
      });
    }
    return this.startup;
  }
  inputError(error: unknown): void {
    this.log.error(error);
    this.publish('error', { message: 'Skrót Copilot jest niedostępny. Uruchom aplikację ponownie lub kliknij orb, aby napisać wiadomość.' });
  }
  private interrupt(): void {
    this.generation++;
    this.current?.controller.abort();
    this.current = null;
    this.pendingExchange = null;
    this.options.engine.cancel();
  }
  private interruptForInput(): 'compose' | 'correct' | 'continue' {
    const operation = this.current;
    const pending = this.pendingExchange;
    const active = this.held || ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(this.phase);
    if (!active) return 'compose';
    const playback = operation?.playbackStarted ?? false;
    // Gesture down must retain its timer, so only cancel recording here.
    this.interrupt(); this.options.recorder.cancel(); this.held = false;
    try {
      if (operation) {
        const partial = playback ? {
          prompt: pending?.question || 'Wiadomość głosowa (transkrypcja niedostępna)',
          answer: pending?.answer || '', interrupted: true } : undefined;
        this.options.engine.interruptTurn?.(operation.checkpoint, partial);
      }
      this.revision++;
      this.publish(this.health === 'ready' ? 'idle' : this.phase, { exchanges: this.options.engine.currentExchanges, generatingImage: false });
    } catch (error) {
      this.log.error(error);
      this.health = 'error';
      this.publish('error', { message: 'Nie udało się zapisać przerwania. Uruchom usługi ponownie przed kolejnym pytaniem.' });
    }
    return playback ? 'continue' : 'correct';
  }
  private checkpoint(): ConversationCheckpoint {
    return { id: this.options.engine.currentThreadId, exchanges: structuredClone(this.options.engine.currentExchanges) };
  }
  private live(operation: Operation): boolean {
    return this.health !== 'stopped' && this.current === operation && this.generation === operation.generation
      && operation.revision === this.revision && !operation.controller.signal.aborted;
  }
  private operation(): Operation {
    const operation = { id: ++this.nextId, revision: this.revision, generation: this.generation, controller: new AbortController(), checkpoint: this.checkpoint(), playbackStarted: false };
    this.current = operation;
    return operation;
  }
  private prepareConversation(): void {
    const engine = this.options.engine, previous = engine.currentThreadId;
    engine.expireConversation();
    if (this.current) this.current.checkpoint = this.checkpoint();
    if (previous && !engine.currentThreadId) {
      this.revision++; if (this.current) this.current.revision = this.revision;
      const question = this.pendingExchange?.question;
      this.publish('thinking', { reset: true, ...(question && { question, answer: '' }) });
    }
  }
  private queue(operation: Operation, work: () => Promise<void>, fallback: string, cleanup?: () => Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!this.live(operation)) return;
        timeout = this.clock.setTimeout(() => {
          if (!this.live(operation)) return;
          operation.controller.abort(); this.options.engine.cancel();
          this.publish('error', { message: 'Operacja przekroczyła limit czasu. Spróbuj ponownie.' });
        }, this.options.operationTimeoutMs ?? 300_000);
        await work();
      }
      catch (error) {
        if (this.live(operation)) { this.log.error(error); this.publish('error', { message: codexErrorMessage(error, fallback) }); }
      } finally {
        this.clock.clearTimeout(timeout);
        try { await cleanup?.(); }
        finally { if (this.current === operation) this.current = null; }
      }
    });
    this.tail = task.catch(error => { this.log.error(error); });
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }
  private beginRecording(interrupt = true): boolean {
    if (this.health !== 'ready' || this.held) return false;
    const interruptedPlayback = this.phase === 'speaking';
    this.held = true; if (interrupt) this.interrupt(); this.recordingStartedAt = this.clock.now();
    if (interruptedPlayback) this.publish('idle');
    try { this.options.recorder.start(); return true; }
    catch (error) {
      this.held = false; this.log.error(error); this.publish('error', { message: 'Nie udało się rozpocząć nagrywania. Spróbuj ponownie.' }); return false;
    }
  }
  private confirmRecording(): void {
    if (!this.held) return;
    if (this.options.desktop) this.options.emit({ type: 'ui', action: 'voice-input' });
    this.log.log('Recording...'); this.publish('listening', { question: '', answer: '' });
  }
  private async releaseRecording(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const releasedAt = this.clock.now(); this.timing('Key hold', releasedAt - this.recordingStartedAt);
    const operation = this.operation();
    // Detach the recorded buffer before another press can start capturing the next utterance.
    let recording: Promise<string>;
    try { recording = this.options.recorder.stop(); }
    catch (error) { recording = Promise.reject(error); }
    void recording.catch(() => {});
    await this.queue(operation, async () => {
      const wav = await recording;
      if (!this.live(operation)) return;
      const recordingDoneAt = this.clock.now();
      const recorder = this.options.recorder;
      if (this.options.debug) this.log.log(`[audio] ${recorder.lastDurationSeconds.toFixed(2)} s, RMS ${recorder.lastRmsDbfs.toFixed(1)} dBFS, peak ${recorder.lastPeakDbfs.toFixed(1)} dBFS`);
      let prepared = false, playbackStartedAt: number | undefined;
      const callbacks: VoiceCallbacks = {
        onUpdate: (state, text) => {
          if (!this.live(operation)) return;
          if (state === 'thinking' && !prepared) { this.prepareConversation(); prepared = true; }
          this.publish(state, { ...text, generatingImage: state === 'thinking' && Boolean(text?.question && imageRequest(text.question)) });
        },
        onPlaybackStart: () => {
          if (!this.live(operation) || playbackStartedAt !== undefined) return;
          operation.playbackStarted = true;
          playbackStartedAt = this.clock.now(); this.publish('speaking');
          this.timing('Recording end to playback start', playbackStartedAt - releasedAt);
        },
        onLevel: level => { if (this.live(operation)) this.level('speaking', level); },
        onTiming: (label, ms) => { if (this.live(operation)) this.timing(label, ms); },
      };
      const reply = await this.options.engine.respondAudio(wav, operation.controller.signal, callbacks);
      if (!this.live(operation)) return;
      this.completed(reply);
      this.timing('Recording finalization', recordingDoneAt - releasedAt);
      if (playbackStartedAt !== undefined) this.timing('Playback duration after player start', this.clock.now() - playbackStartedAt);
      this.timing('Full cycle after key release', this.clock.now() - releasedAt);
    }, 'Nie udało się przygotować lub odczytać odpowiedzi. Spróbuj nagrać pytanie ponownie. Szczegóły są w terminalu.',
    // A cancelled queued operation still owns its detached WAV and must clean it exactly once.
    () => recording.then(wav => this.discardAudio(wav), () => {}));
  }
  private async discardAudio(wav: string): Promise<void> {
    if (this.options.saveAudio) this.log.log(`Saved WAV recording: ${wav}`);
    else await this.options.removeAudio(wav).catch(() => {});
  }
  private completed(reply?: VoiceReply): void {
    if (reply) this.log.log(`\n[Question]\n${reply.prompt}\n\n[Answer]\n${reply.answer}\n`);
    this.revision++;
    this.publish('idle', { exchanges: this.options.engine.currentExchanges, generatingImage: false });
    this.log.log('Ready.');
  }
  handleKey(event: KeyEvent): void {
    if (this.health === 'stopped') return;
    if (event.event === 'down') this.pressed.add(event.vk); else this.pressed.delete(event.vk);
    if (event.event === 'down' && event.vk === 78 && [17, 162, 163].some(key => this.pressed.has(key))
      && [16, 160, 161].some(key => this.pressed.has(key))) { void this.command({ command: 'reset' }); return; }
    if (event.vk !== (this.options.key ?? 134)) return;
    if (this.options.desktop) { if (event.event === 'down') this.gesture.down(); else this.gesture.up(); }
    else if (this.health !== 'ready') return;
    else if (event.event === 'down') { if (this.beginRecording()) this.confirmRecording(); }
    else { void this.releaseRecording(); }
  }
  async command(value: unknown): Promise<boolean> {
    const message = parseApplicationCommand(value);
    if (!message || this.health === 'stopped') return false;
    if (message.command === 'shutdown') { await this.shutdown(); return true; }
    if (message.command === 'tap') {
      this.gesture.cancel();
      this.pressIntent = this.interruptForInput();
      this.options.emit({ type: 'ui', action: this.pressIntent }); return true;
    }
    if (message.command === 'record' || message.command === 'release') {
      this.handleKey({ event: message.command === 'record' ? 'down' : 'up', vk: this.options.key ?? 134, scan: 0, flags: 0 }); return true;
    }
    if (message.command === 'cancel' || message.command === 'reset') {
      this.gesture.cancel(); this.interrupt(); this.options.recorder.cancel(); this.held = false;
      try {
        if (message.command === 'reset') { this.options.engine.reset(); this.revision++; this.log.log('New conversation.'); }
        this.publish(this.health === 'ready' ? 'idle' : 'starting', message.command === 'reset' ? { reset: true } : {});
      } catch (error) { this.log.error(error); this.publish('error', { message: 'Nie udało się rozpocząć nowej rozmowy. Spróbuj ponownie.' }); }
      return true;
    }
    if (this.health !== 'ready' || this.current || this.held) return false;
    if (message.command === 'previous' && !this.options.engine.canRestorePrevious) return false;
    const operation = this.operation();
    if (message.command === 'text') {
      if (this.options.desktop) this.options.emit({ type: 'ui', action: 'text-input' });
      this.publish('thinking', { question: message.text, answer: '', generatingImage: Boolean(imageRequest(message.text)) });
      await this.queue(operation, async () => {
        this.prepareConversation(); await this.options.engine.respond(message.text, operation.controller.signal);
        if (this.live(operation)) this.completed();
      }, 'Nie udało się przygotować odpowiedzi. Wyślij wiadomość ponownie.');
    } else {
      this.publish('thinking');
      await this.queue(operation, async () => {
        const restored = await this.options.engine.restorePrevious(operation.controller.signal);
        if (!this.live(operation)) return;
        if (restored) this.revision++;
        this.publish('idle', restored ? { restored: true, exchanges: this.options.engine.currentExchanges } : {});
      }, 'Nie udało się przywrócić rozmowy. Spróbuj ponownie.');
    }
    return true;
  }
  async maintainHistory(): Promise<boolean> {
    if (this.health !== 'ready' || this.current || this.held || this.tasks.size || this.maintaining) return false;
    this.maintaining = true;
    const generation = this.generation;
    try {
      const cleanup = this.options.engine.maintainHistory?.() ?? Promise.resolve(false);
      this.tail = cleanup.then(() => {}, () => {});
      const changed = await cleanup;
      if (changed && generation === this.generation && !this.current && !this.held && this.health === 'ready') {
        this.revision++; this.publish('idle', { exchanges: this.options.engine.currentExchanges, purgeHistory: true });
      }
      return Boolean(changed);
    } catch (error) {
      this.log.error('Application history cleanup failed:', error);
      if (generation === this.generation && !this.current && !this.held) this.publish('error', { message: 'Nie udało się usunąć starej historii. Aplikacja spróbuje ponownie za minutę.' });
      return false;
    } finally { this.maintaining = false; }
  }
  shutdown(): Promise<void> {
    if (!this.closing) {
      this.health = 'stopped'; this.gesture.cancel(); this.clock.clearInterval(this.maintenanceTimer);
      this.interrupt(); this.options.recorder.shutdown(); this.options.engine.stop();
      this.closing = (async () => {
        if (!this.tasks.size) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled(this.tasks), new Promise<void>(resolve => {
          timer = this.clock.setTimeout(resolve, this.options.shutdownTimeoutMs ?? 3000);
        })]);
        this.clock.clearTimeout(timer);
      })();
    }
    return this.closing;
  }
}
