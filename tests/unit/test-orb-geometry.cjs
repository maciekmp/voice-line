const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const geometry = require('../../electron/orb-geometry.cjs');
const { createPointerTracker } = require('../../electron/overlay-pointer.cjs');

for (const scale of [1, 1.25, 1.5, 2]) test(`64 x 80 orb target and label at scale ${scale}`, () => {
  const origin = { x: 100, y: 200 };
  const orb = { ...origin, width: 64 * scale, height: 80 * scale };
  const points = [[32, 8, true], [32, 64, false], [32, 5, true], [32, 4.9, false],
    [32, 59, true], [32, 59.1, false], [5, 32, true], [59, 32, true], [5, 5, false]];
  for (const [x, y, expected] of points) {
    let hovered = false;
    const track = createPointerTracker((surface, entered) => { if (surface === 'orb') hovered = entered; });
    track({ x: origin.x + x * scale, y: origin.y + y * scale }, { orb, panel: null });
    assert.equal(hovered, expected, `point (${x}, ${y})`);
  }
});

test('renderer CSS receives the same geometry as native pointer tracking', () => {
  const properties = {};
  vm.runInNewContext(readFileSync(require.resolve('../../electron/orb-geometry.cjs'), 'utf8'), {
    document: { documentElement: { style: { setProperty: (key, value) => { properties[key] = value; } } } },
  });
  assert.equal(properties['--orb-button-size'], `${geometry.buttonSize}px`);
  assert.equal(properties['--orb-button-top'], `${geometry.buttonTop}px`);
  assert.equal(properties['--orb-button-left'], `${geometry.buttonLeft}px`);
});
