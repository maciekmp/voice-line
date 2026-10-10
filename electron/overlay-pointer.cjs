const geometry = require('./orb-geometry.cjs');
/** @typedef {{x: number, y: number, width: number, height: number}} Rect */
/** @param {(surface: 'orb' | 'panel', entered: boolean) => void} onHover */
function createPointerTracker(onHover) {
  let previous = { orb: false, panel: false };
  /** @param {{x: number, y: number}} cursor @param {{orb: Rect | null, panel: Rect | null}} surfaces */
  return (cursor, surfaces) => {
    const { orb, panel } = surfaces;
    /** @param {Rect} rect */
    const inside = rect => cursor.x >= rect.x && cursor.x < rect.x + rect.width
      && cursor.y >= rect.y && cursor.y < rect.y + rect.height;
    const current = {
      // Electron supplies both bounds and cursor in DIP. Label height is not part of the target.
      orb: Boolean(orb && Math.hypot(
        (cursor.x - orb.x) / (orb.width / geometry.windowWidth) - geometry.buttonLeft - geometry.buttonSize / 2,
        (cursor.y - orb.y) / (orb.width / geometry.windowWidth) - geometry.buttonTop - geometry.buttonSize / 2,
      ) <= geometry.buttonSize / 2),
      panel: Boolean(panel && inside(panel)),
    };
    // Entries precede exits, avoiding a timer when crossing between windows.
    for (const entered of [true, false]) for (const surface of /** @type {const} */ (['orb', 'panel'])) {
      if (current[surface] === entered && current[surface] !== previous[surface]) onHover(surface, entered);
    }
    previous = current;
  };
}
module.exports = { createPointerTracker };
