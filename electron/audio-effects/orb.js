import { createMeteredOrb } from './metered-orb.js';

/** @param {import('./index.js').EffectTargets} targets */
export function createOrb({ slot }) {
  return createMeteredOrb(slot, 'voice-orb', '1');
}
