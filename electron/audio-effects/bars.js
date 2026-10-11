/** @param {import('./index.js').EffectTargets} targets */
export function createBars({ slot }) {
  const bars = Array.from({ length: 3 }, () => document.createElement('span'));
  slot.append(...bars);
  return {
    /** @param {import('./index.js').EffectFrame} frame */
    update({ level }) { slot.style.setProperty('--audio-level', String(level)); },
    dispose() {
      bars.forEach(bar => bar.remove());
      slot.style.setProperty('--audio-level', '0');
    },
  };
}
