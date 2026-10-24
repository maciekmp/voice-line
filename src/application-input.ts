import { ApplicationController, type ControllerClock } from './application-controller.ts';
import { parseInputCommand, type ApplicationEvent, type CommandReceipt, type InputIntent } from './application-contract.ts';
import { createCopilotGesture } from './keyboard/copilot-gesture.ts';
import type { KeyEvent } from './keyboard/copilot-key.ts';

// The same input flow drives the terminal and Electron. Physical keys and tap/hold
// timing belong here; conversation transitions belong to ApplicationController.
export class ApplicationInput {
  private readonly controller: ApplicationController;
  private readonly emit: (event: ApplicationEvent) => void;
  private readonly key: number;
  private readonly gesture: ReturnType<typeof createCopilotGesture>;
  private readonly pressed = new Set<number>();
  private intent: InputIntent = 'compose';
  private recording = false;
  private disposed = false;

  constructor(controller: ApplicationController, emit: (event: ApplicationEvent) => void,
    options: { key?: number; clock?: ControllerClock } = {}) {
    this.controller = controller; this.emit = emit; this.key = options.key ?? 134;
    this.gesture = createCopilotGesture({
      down: () => {
        this.intent = controller.interruptForInput();
        this.recording = controller.beginRecording();
      },
      hold: () => {
        if (this.recording) { controller.confirmRecording(); this.show('voice-input'); }
        else this.show(this.intent);
      },
      tap: () => { controller.discardRecording(); this.recording = false; this.show(this.intent); },
      release: () => { this.recording = false; void controller.releaseRecording(); },
    }, 250, options.clock, options.clock ? () => options.clock!.now() : undefined);
  }

  private show(action: 'voice-input' | 'text-input' | InputIntent): void { this.emit({ type: 'ui', action }); }

  handleKey(event: KeyEvent): void {
    if (this.disposed) return;
    const repeat = this.pressed.has(event.vk);
    if (event.event === 'down') this.pressed.add(event.vk); else this.pressed.delete(event.vk);
    if (event.event === 'down' && !repeat && event.vk === 78 && [17, 162, 163].some(key => this.pressed.has(key))
      && [16, 160, 161].some(key => this.pressed.has(key))) { this.dispatch({ command: 'reset' }); return; }
    if (event.vk === this.key && !(repeat && event.event === 'down')) this.dispatch({ command: event.event === 'down' ? 'record' : 'release' });
  }

  dispatch(value: unknown): CommandReceipt {
    const message = parseInputCommand(value);
    if (!message || this.disposed || this.controller.snapshot().health === 'stopped') {
      return { result: { accepted: false, reason: message ? 'unavailable' : 'invalid' }, completion: Promise.resolve() };
    }
    if (message.command === 'record') this.gesture.down();
    else if (message.command === 'release') this.gesture.up();
    else if (message.command === 'tap') {
      this.gesture.cancel(); this.recording = false;
      this.show(this.controller.interruptForInput()); this.controller.discardRecording();
    } else {
      if (['cancel', 'reset', 'shutdown'].includes(message.command)) { this.gesture.cancel(); this.recording = false; }
      const receipt = this.controller.dispatch(message);
      if (receipt.result.accepted && message.command === 'text') this.show('text-input');
      return receipt;
    }
    return { result: { accepted: true, operationId: this.controller.snapshot().operationId }, completion: Promise.resolve() };
  }

  async command(value: unknown): Promise<boolean> {
    const receipt = this.dispatch(value);
    await receipt.completion;
    return receipt.result.accepted;
  }

  dispose(): void { this.disposed = true; this.gesture.cancel(); this.pressed.clear(); this.controller.discardRecording(); }
}
