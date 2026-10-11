import '../voice-orb.js';

/** Shared lifecycle for effects using the orb's WebGL renderer.
 * @param {HTMLElement} target @param {string} tag @param {string} scale
 */
export function createMeteredOrb(target, tag, scale) {
  const element = /** @type {HTMLElement & { level: number }} */ (document.createElement(tag));
  element.setAttribute('audio-reactive', '');
  element.setAttribute('metered-envelope', '');
  element.setAttribute('render-scale', scale);
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('paused', '');
  target.append(element);
  return {
    /** @param {import('./index.js').EffectFrame} frame */
    update({ level, state, static: stopped }) {
      element.level = level;
      if (!level) element.style.setProperty('--audio-scale', '1');
      // Avoid renderer refreshes on audio frames with unchanged attributes.
      if (element.getAttribute('state') !== state) element.setAttribute('state', state);
      if (element.hasAttribute('paused') !== stopped) element.toggleAttribute('paused', stopped);
    },
    dispose() { element.remove(); }, // disconnectedCallback releases the renderer.
  };
}
