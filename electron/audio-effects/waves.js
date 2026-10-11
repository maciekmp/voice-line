import { createMeteredOrb } from './metered-orb.js';

/** @param {import('./index.js').EffectTargets} targets */
export function createWaves({ waves }) {
  const renderer = createMeteredOrb(waves, 'voice-waves', '.5');
  return {
    /** @param {import('./index.js').EffectFrame} frame */
    update(frame) {
      waves.style.opacity = frame.visible && frame.level > .001 ? String(frame.level * .18) : '0';
      renderer.update(frame);
    },
    dispose() {
      waves.style.opacity = '0';
      renderer.dispose();
    },
  };
}
