/** @param {import('./index.js').EffectTargets} targets */
export function createGlow({ glow }) {
  return {
    /** @param {import('./index.js').EffectFrame} frame */
    update({ level }) { glow.style.opacity = String(level * .55); },
    dispose() { glow.style.opacity = '0'; },
  };
}
