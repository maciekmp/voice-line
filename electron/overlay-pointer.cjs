/** @typedef {{x: number, y: number, width: number, height: number}} Rect */
/** @param {(surface: 'panel', entered: boolean) => void} onHover */
function createPointerTracker(onHover) {
  let previous = false;
  /** @param {{x: number, y: number}} cursor @param {{panel: Rect | null}} surfaces */
  return (cursor, { panel }) => {
    const current = Boolean(panel && cursor.x >= panel.x && cursor.x < panel.x + panel.width
      && cursor.y >= panel.y && cursor.y < panel.y + panel.height);
    if (current !== previous) onHover('panel', current);
    previous = current;
  };
}
module.exports = { createPointerTracker };
