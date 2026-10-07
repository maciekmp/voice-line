function createPointerTracker(onHover) {
  let previous = { orb: false, panel: false };
  return (cursor, surfaces) => {
    const { orb, panel } = surfaces;
    const inside = rect => cursor.x >= rect.x && cursor.x < rect.x + rect.width
      && cursor.y >= rect.y && cursor.y < rect.y + rect.height;
    const current = {
      orb: Boolean(orb && Math.hypot(cursor.x - orb.x - orb.width / 2,
        cursor.y - orb.y - orb.height / 2) <= 27),
      panel: Boolean(panel && inside(panel)),
    };
    // Entries precede exits, avoiding a timer when crossing between windows.
    for (const entered of [true, false]) for (const surface of ['orb', 'panel']) {
      if (current[surface] === entered && current[surface] !== previous[surface]) onHover(surface, entered);
    }
    previous = current;
  };
}
module.exports = { createPointerTracker };
