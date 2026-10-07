const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayController } = require('../electron/overlay-controller.cjs');
const { createPointerTracker } = require('../electron/overlay-pointer.cjs');

function setup() {
  let time = 0, id = 0;
  const tasks = new Map();
  const changes = [];
  const controller = createOverlayController({ onChange: value => changes.push(value), timers: {
    setTimeout(callback, delay) { const key = ++id; tasks.set(key, { at: time + delay, callback }); return key; },
    clearTimeout(key) { tasks.delete(key); },
  } });
  return { controller, changes, advance(ms) {
    time += ms;
    for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.callback(); }
  } };
}
test('Copilot tap opens input-only mode without hover and retains the idle orb', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.compose(); advance(2000); c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'compose', orbVisible: true });
  c.hover('orb', true); c.open(false);
  assert.equal(c.snapshot().mode, 'compose', 'Hover does not expose old answers');
  c.hover('orb', false); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false });
});

test('sending a new question reveals chat from the input-only mode', () => {
  const { controller: c } = setup();
  c.voice('idle'); c.compose(); c.voice('thinking');
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
  c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
});

test('orb activation toggles chat and peek, including during a voice cycle', () => {
  const { controller: c } = setup();
  c.voice('idle'); c.toggle();
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
  c.toggle();
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true });
  c.voice('speaking'); c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true });
  c.toggle(); assert.equal(c.snapshot().mode, 'chat');
  c.compose(); c.toggle(); assert.equal(c.snapshot().mode, 'peek');
});

test('collapse clears an old exit timeout and leaving still dismisses after a second', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.toggle(); c.hover('orb', false); advance(900);
  c.toggle(); advance(300);
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true });
  c.hover('orb', true); c.hover('orb', false); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false });
});

test('click keeps chat open through the whole next voice cycle', () => {
  const { controller: c } = setup();
  c.hover('orb', true); c.open();
  for (const state of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'idle']) {
    c.voice(state);
    assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
  }
});
test('starting another recording invalidates a previous hide timeout', () => {
  const { controller: c, advance } = setup();
  c.voice('speaking'); c.hover('orb', true); c.open(); c.hover('orb', false);
  advance(900); c.voice('listening'); advance(300);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
});
test('moving from orb into popup preserves chat, leaving both hides after a second', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.open(); c.hover('orb', false); advance(400);
  c.hover('panel', true); advance(800);
  assert.equal(c.snapshot().mode, 'chat');
  c.hover('panel', false); advance(999);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
  advance(1); assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false });
});
test('rapid reopen cancels an old timeout and hover never downgrades chat', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.open(); c.hover('orb', false); advance(900);
  c.open(); c.hover('orb', true); c.open(false); advance(500);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
});
test('idle hides an untouched orb and repeated snapshots do not reactivate windows', () => {
  const { controller: c, changes } = setup();
  c.voice('listening'); assert.equal(c.snapshot().orbVisible, true);
  c.voice('idle'); assert.equal(c.snapshot().orbVisible, false);
  c.hover('orb', true); c.open();
  const count = changes.length;
  c.voice('speaking'); c.voice('speaking'); c.voice('idle');
  assert.equal(changes.length, count);
});
test('native pointer tracking keeps a stationary cursor inside a resized popup', () => {
  const { controller: c, advance } = setup();
  const track = createPointerTracker((surface, entered) => c.hover(surface, entered));
  const orb = { x: 400, y: 500, width: 64, height: 64 };
  const panel = { x: 84, y: 300, width: 380, height: 192 };
  track({ x: 432, y: 532 }, { orb, panel: null }); c.open();
  track({ x: 100, y: 400 }, { orb, panel });
  c.voice('listening');
  track({ x: 100, y: 400 }, { orb, panel: { ...panel, y: 200, height: 292 } });
  advance(2000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true });
  track({ x: 0, y: 0 }, { orb, panel }); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false });
});
