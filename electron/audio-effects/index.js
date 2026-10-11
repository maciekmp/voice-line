import { createBars } from './bars.js';
import { createOrb } from './orb.js';
import { createGlow } from './glow.js';
import { createWaves } from './waves.js';

/**
 * Each effect owns its DOM and releases it on dispose. The controller alone
 * owns audio smoothing, visibility, pause and reduced-motion decisions.
 * @typedef {{ slot: HTMLElement, glow: HTMLElement, waves: HTMLElement }} EffectTargets
 * @typedef {{ level: number, state: string, static: boolean, visible: boolean }} EffectFrame
 * @typedef {{ update(frame: EffectFrame): void, dispose(): void }} AudioEffect
 */
const effects = { bars: createBars, orb: createOrb, glow: createGlow, waves: createWaves };

/** @param {import('../../src/desktop-contract.ts').AudioIndicator} variant
 * @param {EffectTargets} targets @returns {AudioEffect}
 */
export function createAudioEffect(variant, targets) {
  return effects[variant](targets);
}
