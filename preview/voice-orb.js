// Visual prototype; no microphone access. Import as a browser module.
import { OrbRenderer } from './orb-renderer.js';
const states = new Set(['idle', 'listening', 'speaking']);

class VoiceOrb extends HTMLElement {
  static observedAttributes = ['state', 'paused', 'render-scale'];
  renderer;
  level = 0;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `
      <style>
        :host {
          position: relative;
          display: inline-block;
          width: var(--orb-size, 45px);
          max-width: 100%;
          aspect-ratio: 1;
        }
        .sphere {
          transform: scale(1);
          position: relative;
          width: 100%; height: 100%;
          overflow: hidden; border-radius: 50%; isolation: isolate;
          /* The browser draws this mask at screen resolution, independently of the canvas buffer. */
          clip-path: circle(50% at 50% 50%);
          background: linear-gradient(to top, #b3c2fa 0%, #b3c2fa 22%, #dde6fd 40%, #f7fbff 52%, #bacbf9 66%, #3361e8 88%, #3361e8 100%);
          box-shadow: none;
        }
        canvas { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: auto; }
        .sphere.rendered { background: transparent; }
        :host([state="listening"]) .sphere { animation: listen-breathe 2.2s ease-in-out infinite; }
        :host([state="speaking"]) .sphere { animation: speak-breathe 1.1s ease-in-out infinite; }
        :host([paused]) .sphere { animation-play-state: paused; }
        :host([audio-reactive]) .sphere {
          animation: none; scale: var(--audio-scale, 1);
          transition: scale 40ms ease-out;
        }
        @keyframes listen-breathe { 0%, 100% { transform: scale(.94); } 50% { transform: scale(1); } }
        @keyframes speak-breathe { 0%, 100% { transform: scale(.97); } 45% { transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) { .sphere { animation: none !important; scale: 1 !important; transition: none !important; } }
      </style>
      <div class="sphere" aria-hidden="true">
        <canvas></canvas>
      </div>
      <slot name="overlay"></slot>
    `;
  }

  connectedCallback() {
    this.setAttribute('role', 'img');
    this.updateLabel();
    this.renderer = new OrbRenderer(this, this.shadowRoot.querySelector('canvas'));
  }

  disconnectedCallback() { this.renderer?.dispose(); this.renderer = undefined; }
  attributeChangedCallback() { this.updateLabel(); this.renderer?.refresh(); }

  get state() {
    const value = this.getAttribute('state');
    return states.has(value) ? value : 'idle';
  }

  set state(value) {
    if (!states.has(value)) throw new TypeError(`Unknown orb state: ${value}`);
    this.setAttribute('state', value);
  }

  updateLabel() {
    const labels = { idle: 'Spoczynek', listening: 'Słuchanie', speaking: 'Mówienie' };
    this.setAttribute('aria-label', `Niebieska kulka: ${labels[this.state]}`);
  }
}

customElements.define('voice-orb', VoiceOrb);
