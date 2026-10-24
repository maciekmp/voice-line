import type { VoiceEngine, VoiceCallbacks } from './voice-engine.ts';
import type { ConversationExchange, ConversationCheckpoint } from './conversation-contract.ts';
import { parseApplicationCommand, type ApplicationEvent, type ApplicationSnapshot, type ServiceHealth, type ApplicationState, type PendingExchange,
  type ApplicationCapabilities, type InputIntent, type CommandReceipt } from './application-contract.ts';
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
  engine: VoiceEngine; recorder?: AudioRecorder; emit: (event: ApplicationEvent) => void;
  removeAudio: (wav: string) => Promise<void>; saveAudio?: boolean; debug?: boolean; playback?: boolean; recordingUnavailableMessage?: string;
  clock?: ControllerClock; log?: Pick<Console, 'log' | 'error'>; operationTimeoutMs?: number; shutdownTimeoutMs?: number;
};

export class ApplicationController {
  private readonly options: Options;
  private readonly clock: ControllerClock;
  private readonly log: Pick<Console, 'log' | 'error'>;
  private health: ServiceHealth = 'starting';
  private capabilities: ApplicationCapabilities = {
    text: { state: 'starting' }, recording: { state: 'starting' }, playback: { state: 'starting' },
  };
  private phase: ApplicationState = 'starting';
  private message = '';
  private generatingImage = false;
  private held = false;
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
    if (options.recorder) options.recorder.onLevel = level => this.level('listening', level);
  }

  snapshot(): ApplicationSnapshot {
    const engine = this.options.engine;
    return { type: 'voice', state: this.phase, ready: this.health === 'ready', health: this.health, capabilities: structuredClone(this.capabilities),
      mode: engine.mode, threadId: engine.currentThreadId, canRestorePrevious: engine.canRestorePrevious,
      revision: this.revision, operationId: this.current?.id ?? null, message: this.message, generatingImage: this.generatingImage,
      conversation: { id: engine.currentThreadId, revision: this.conversationRevision,
        completed: this.completedExchanges, pending: this.pendingExchange } };
  }
  private publish(state: ApplicationState, extra: Partial<Pick<ApplicationSnapshot,
    'question' | 'answer' | 'questionSource' | 'exchanges' | 'reset' | 'restored' | 'purgeHistory' | 'generatingImage' | 'message'>> = {}): void {
    if (this.health === 'stopped') return;
    if ('message' in extra) this.message = extra.message ?? '';
    else if (state !== 'error') this.message = '';
    this.generatingImage = extra.generatingImage ?? (state === 'thinking' && this.generatingImage);
    if (Array.isArray(extra.exchanges)) {
      this.completedExchanges = structuredClone(extra.exchanges);
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
          questionSource: extra.questionSource === 'voice' || extra.questionSource === 'text' ? extra.questionSource : this.pendingExchange?.questionSource,
        };
      }
    }
    this.phase = state;
    this.options.emit({ ...extra, ...this.snapshot() });
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
      const initialize = async (name: keyof ApplicationCapabilities, work: () => Promise<void>, fallback: string) => {
        try {
          await work();
          if (this.health === 'stopped') return;
          this.capabilities[name] = { state: 'ready' };
        } catch (error) {
          if (this.health === 'stopped') return;
          this.log.error(error);
          this.capabilities[name] = { state: 'error', message: codexErrorMessage(error, fallback) };
        }
        if (name === 'text') {
          this.health = this.capabilities.text.state === 'ready' ? 'ready' : 'error';
          this.publish(this.health === 'ready' ? 'idle' : 'error', {
            exchanges: this.options.engine.currentExchanges, message: this.capabilities.text.message,
          });
        } else this.publish(this.phase);
      };
      if (!this.options.recorder) this.capabilities.recording = { state: 'disabled', message: this.options.recordingUnavailableMessage ?? 'Ustaw MIC_DEVICE, aby korzystać z mikrofonu.' };
      if (this.options.playback === false) this.capabilities.playback = { state: 'disabled' };
      this.startup = Promise.all([
        initialize('text', () => this.options.engine.start(), 'Nie udało się uruchomić rozmowy. Sprawdź konfigurację Codex i ponów uruchomienie usług.'),
        ...(this.options.recorder ? [initialize('recording', async () => {
          const results = await Promise.allSettled([this.options.engine.startVoice(), this.options.recorder!.startCapture()]);
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') { this.options.recorder!.shutdown(); throw failure.reason; }
        }, 'Nagrywanie jest niedostępne. Sprawdź mikrofon i ustawienia rozpoznawania mowy. Możesz nadal pisać.')] : []),
        ...(this.options.playback === false ? [] : [initialize('playback', () => this.options.engine.startPlayback(), 'Odczytywanie jest niedostępne. Odpowiedzi będą wyświetlane jako tekst.')]),
      ]).then(() => {
        if (this.health === 'stopped') return;
        this.maintenanceTimer = this.clock.setInterval(() => { void this.maintainHistory(); }, 60_000);
        this.maintenanceTimer.unref?.();
      });
    }
    return this.startup;
  }
  private interrupt(): void {
    this.generation++;
    this.current?.controller.abort();
    this.current = null;
    this.pendingExchange = null;
    this.options.engine.cancel();
  }
  interruptForInput(): InputIntent {
    const operation = this.current;
    const pending = this.pendingExchange;
    const active = Boolean(operation) || this.held || ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(this.phase);
    if (!active) return 'compose';
    const playback = operation?.playbackStarted ?? false;
    this.interrupt(); this.options.recorder?.cancel(); this.held = false;
    try {
      if (operation) {
        const partial = playback ? {
          prompt: pending?.question || 'Wiadomość głosowa (transkrypcja niedostępna)',
          answer: pending?.answer || '', questionSource: pending?.questionSource, interrupted: true } : undefined;
        this.options.engine.interruptTurn?.(operation.checkpoint, partial);
      }
      this.revision++;
      this.publish(this.health === 'ready' ? 'idle' : this.phase, { exchanges: this.options.engine.currentExchanges, generatingImage: false });
    } catch (error) {
      this.log.error(error);
      this.health = 'error';
      this.capabilities.text = { state: 'error', message: 'Nie udało się zapisać przerwania. Uruchom usługi ponownie przed kolejnym pytaniem.' };
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
      const questionSource = this.pendingExchange?.questionSource;
      this.publish('thinking', { reset: true, ...(question && { question, answer: '', questionSource }) });
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
  beginRecording(): boolean {
    if (this.health !== 'ready' || this.capabilities.recording.state !== 'ready' || this.current || this.held || !this.options.recorder) return false;
    this.held = true; this.recordingStartedAt = this.clock.now();
    try { this.options.recorder.start(); return true; }
    catch (error) {
      this.held = false; this.log.error(error); this.publish('error', { message: 'Nie udało się rozpocząć nagrywania. Spróbuj ponownie.' }); return false;
    }
  }
  confirmRecording(): void {
    if (!this.held) return;
    this.publish('listening', { question: '', answer: '', questionSource: 'voice' });
  }
  discardRecording(): void {
    if (!this.held) return;
    this.options.recorder?.cancel(); this.held = false;
    this.publish(this.health === 'ready' ? 'idle' : this.phase);
  }
  async releaseRecording(): Promise<void> {
    if (!this.held) return;
    const recorder = this.options.recorder!;
    this.held = false;
    const releasedAt = this.clock.now(); this.timing('Key hold', releasedAt - this.recordingStartedAt);
    const operation = this.operation();
    // Detach the recorded buffer before another press can start capturing the next utterance.
    let recording: Promise<string>;
    try { recording = recorder.stop(); }
    catch (error) { recording = Promise.reject(error); }
    void recording.catch(() => {});
    await this.queue(operation, async () => {
      const wav = await recording;
      if (!this.live(operation)) return;
      const recordingDoneAt = this.clock.now();
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
      await this.options.engine.respondAudio(wav, operation.controller.signal, callbacks, { playback: this.capabilities.playback.state === 'ready' });
      if (!this.live(operation)) return;
      this.completed();
      this.timing('Recording finalization', recordingDoneAt - releasedAt);
      if (playbackStartedAt !== undefined) this.timing('Playback duration after player start', this.clock.now() - playbackStartedAt);
      this.timing('Full cycle after key release', this.clock.now() - releasedAt);
    }, 'Nie udało się przygotować lub odczytać odpowiedzi. Spróbuj ponownie.',
    // A cancelled queued operation still owns its detached WAV and must clean it exactly once.
    () => recording.then(wav => this.discardAudio(wav), () => {}));
  }
  private async discardAudio(wav: string): Promise<void> {
    if (this.options.saveAudio) this.options.emit({ type: 'notice', message: `Zapisano nagranie WAV: ${wav}` });
    else await this.options.removeAudio(wav).catch(() => {});
  }
  private completed(): void {
    this.current = null;
    this.revision++;
    this.publish('idle', { exchanges: this.options.engine.currentExchanges, generatingImage: false });
  }
  // Admission is synchronous; completion is separate so transports can acknowledge
  // a request before inference finishes. Only this owner decides whether work may start.
  dispatch(value: unknown): CommandReceipt {
    const completion = Promise.resolve();
    const reject = (reason: 'invalid' | 'unavailable' | 'busy' | 'no-previous'): CommandReceipt => ({ result: { accepted: false, reason }, completion });
    const accept = (work = completion): CommandReceipt => ({ result: { accepted: true, operationId: this.current?.id ?? null }, completion: work });
    const message = parseApplicationCommand(value);
    if (!message) return reject('invalid');
    if (this.health === 'stopped') return reject('unavailable');
    if (message.command === 'shutdown') return accept(this.shutdown());
    if (message.command === 'cancel' || message.command === 'reset') {
      const interrupted = this.current !== null || this.held;
      this.interruptForInput();
      if (!interrupted) this.interrupt();
      this.options.recorder?.cancel(); this.held = false;
      try {
        if (message.command === 'reset') { this.options.engine.reset(); this.revision++; }
        this.publish(this.health === 'ready' ? 'idle' : this.health === 'error' ? 'error' : 'starting',
          { exchanges: this.options.engine.currentExchanges, ...(message.command === 'reset' && { reset: true }), generatingImage: false });
      } catch (error) { this.log.error(error); this.publish('error', { message: 'Nie udało się rozpocząć nowej rozmowy. Spróbuj ponownie.' }); }
      return accept();
    }
    if (this.health !== 'ready') return reject('unavailable');
    if (this.current || this.held) return reject('busy');
    if (message.command === 'previous' && !this.options.engine.canRestorePrevious) return reject('no-previous');
    const operation = this.operation();
    if (message.command === 'text') {
      this.publish('thinking', { question: message.text, answer: '', questionSource: 'text', generatingImage: Boolean(imageRequest(message.text)) });
      return accept(this.queue(operation, async () => {
        this.prepareConversation(); await this.options.engine.respond(message.text, operation.controller.signal);
        if (this.live(operation)) this.completed();
      }, 'Nie udało się przygotować odpowiedzi. Wyślij wiadomość ponownie.'));
    }
    this.publish('thinking');
    return accept(this.queue(operation, async () => {
      const restored = await this.options.engine.restorePrevious(operation.controller.signal);
      if (!this.live(operation)) return;
      if (restored) this.revision++;
      this.current = null;
      this.publish('idle', restored ? { restored: true, exchanges: this.options.engine.currentExchanges } : {});
    }, 'Nie udało się przywrócić rozmowy. Spróbuj ponownie.'));
  }
  async command(value: unknown): Promise<boolean> {
    const receipt = this.dispatch(value);
    await receipt.completion;
    return receipt.result.accepted;
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
      this.health = 'stopped'; this.clock.clearInterval(this.maintenanceTimer);
      for (const key of ['text', 'recording', 'playback'] as const) this.capabilities[key] = { state: 'stopped' };
      this.interrupt(); this.options.recorder?.shutdown(); this.options.engine.stop();
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
