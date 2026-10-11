import { createAudioEffect } from './audio-effects/index.js';

/** Display-only audio feedback. Native snapshots remain the source of application state. */
export class AudioIndicator {
  state = 'starting';
  /** @type {import('../src/desktop-contract.ts').AudioIndicator} */
  variant = 'bars';
  paused = false;
  visible = false;
  level = 0;
  envelope = 0;
  frame = 0;
  last = 0;
  motion = matchMedia('(prefers-reduced-motion: reduce)');

  /** @param {HTMLElement} slot @param {HTMLElement} mode @param {HTMLElement} glow @param {HTMLElement} waves */
  constructor(slot, mode, glow, waves) {
    this.slot = slot;
    this.mode = mode;
    this.glow = glow;
    this.waves = waves;
    this.mount();
    this.motion.addEventListener('change', this.refresh);
    document.addEventListener('visibilitychange', this.refresh);
    window.addEventListener('pagehide', () => this.dispose(), { once: true });
  }

  get active() { return this.state === 'listening' || this.state === 'speaking'; }
  get static() { return this.paused || this.motion.matches || !this.visible || document.hidden || !this.active; }

  /** @param {boolean} visible */
  visibility(visible) { this.visible = visible; this.refresh(); }

  mount() {
    this.effect?.dispose();
    this.slot.dataset.variant = this.variant;
    this.effect = createAudioEffect(this.variant, { slot: this.slot, glow: this.glow, waves: this.waves });
  }

  /** @param {import('../src/desktop-contract.ts').DesktopSettings} settings */
  settings(settings) {
    if (settings.indicator !== this.variant) {
      this.variant = settings.indicator;
      this.mount();
    }
    this.paused = settings.paused;
    this.refresh();
  }

  /** @param {Partial<import('../src/desktop-contract.ts').DesktopVoice>} snapshot */
  voice(snapshot) {
    if (this.state !== snapshot.state) this.reset();
    this.state = snapshot.state || 'starting';
    this.mode.textContent = snapshot.mode === 'local' ? 'LOCAL' : snapshot.mode === 'realtime' ? 'API' : '';
    this.mode.hidden = !snapshot.mode;
    this.refresh();
  }

  /** @param {number} level */
  audio(level) {
    if (this.static) return;
    const measured = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    // Lift quieter microphone levels visually; recorded PCM and playback gain are unchanged.
    this.level = this.state === 'listening' ? Math.min(1, Math.pow(measured, .65) * 1.35) : measured;
    if (this.level > this.envelope) {
      this.envelope = this.level;
      this.paint(); // Attack immediately, including between animation frames.
    }
    this.schedule();
  }

  reset() {
    this.level = this.envelope = this.last = 0;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.paint();
  }

  refresh = () => {
    if (this.static) this.reset();
    this.paint();
    if (!this.static) this.schedule();
  };

  schedule() {
    if (!this.frame) {
      if (!this.last) this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  /** @param {number} now */
  tick = now => {
    this.frame = 0;
    if (this.static) { this.reset(); return; }
    const delta = this.last ? Math.min((now - this.last) / 1000, .05) : 0;
    this.last = now;
    this.envelope += (this.level - this.envelope) * (1 - Math.exp(-delta * 20));
    this.paint();
    if (Math.abs(this.envelope - this.level) > .001) this.schedule();
    else this.last = 0;
  };

  paint() {
    this.slot.style.setProperty('--audio-level', String(this.envelope));
    this.effect?.update({ level: this.envelope, state: this.active ? this.state : 'idle', static: this.static, visible: this.visible });
  }

  dispose() {
    this.reset();
    this.effect?.dispose();
    this.motion.removeEventListener('change', this.refresh);
    document.removeEventListener('visibilitychange', this.refresh);
  }
}
