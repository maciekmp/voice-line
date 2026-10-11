const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayController } = require('../../electron/overlay-controller.cjs');
const { createPointerTracker } = require('../../electron/overlay-pointer.cjs');

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

test('interrupted playback keeps focused typing visible past completion and pointer departure', () => {
  const { controller: c, advance } = setup();
  c.voice('speaking'); c.voice('idle'); c.compose(); c.composerFocus(true);
  c.hover('panel', true); c.hover('panel', false);
  advance(2000); advance(10000);
  assert.deepEqual(c.snapshot(), { mode: 'compose', orbVisible: true, pinned: false });
  c.composerFocus(false); advance(999);
  assert.equal(c.snapshot().mode, 'compose');
  advance(1);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});

test('composer focus cancels departure and blur cannot shorten completion grace', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.open(); c.hover('panel', true); c.hover('panel', false);
  advance(900); c.composerFocus(true); advance(2000);
  assert.equal(c.snapshot().mode, 'chat');
  c.voice('speaking'); c.voice('idle'); advance(500); c.composerFocus(false);
  advance(1499); assert.equal(c.snapshot().mode, 'chat');
  advance(1); assert.equal(c.snapshot().mode, 'hidden');
});

test('explicit dismissal and collapse clear composer focus retention', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.compose(); c.composerFocus(true); c.dismiss();
  c.composerFocus(true); advance(3000);
  assert.equal(c.snapshot().mode, 'hidden');
  c.compose(); c.composerFocus(true); c.toggle();
  c.composerFocus(true); c.hover('orb', true); c.hover('orb', false); advance(1000);
  assert.equal(c.snapshot().mode, 'hidden');
});
test('pin cancels pending departure, survives voice completion, and unpin restores hiding', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.open(); c.hover('panel', true); c.hover('panel', false);
  advance(900); c.togglePin(); advance(2000);
  for (const state of ['listening', 'thinking', 'speaking', 'idle']) c.voice(state);
  assert.deepEqual(c.snapshot(), { mode: 'chat', pinned: true, orbVisible: true });
  c.hover('panel', true); c.hover('panel', false); advance(2000);
  assert.equal(c.snapshot().mode, 'chat');
  c.togglePin(); advance(999);
  assert.equal(c.snapshot().mode, 'chat');
  advance(1);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', pinned: false, orbVisible: false });
});

test('explicit dismissal clears pinning and hidden popup cannot be pinned', () => {
  const { controller: c, advance } = setup();
  c.compose(); c.togglePin(); c.dismiss(); c.togglePin();
  assert.deepEqual(c.snapshot(), { mode: 'hidden', pinned: false, orbVisible: false });
  c.open(false); c.togglePin(); c.hover('panel', true); c.togglePin(); advance(2000);
  assert.equal(c.snapshot().mode, 'peek');
  c.hover('panel', false); advance(1000);
  assert.equal(c.snapshot().mode, 'hidden');
});
test('Copilot tap opens input-only mode without hover and retains the idle orb', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.compose(); advance(2000); c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'compose', orbVisible: true, pinned: false });
  c.hover('orb', true); c.open(false);
  assert.equal(c.snapshot().mode, 'compose', 'Hover does not expose old answers');
  c.hover('orb', false); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});

test('sending a new question reveals chat from the input-only mode', () => {
  const { controller: c } = setup();
  c.voice('idle'); c.compose(); c.voice('thinking');
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
});

test('orb activation toggles chat and peek, including during a voice cycle', () => {
  const { controller: c } = setup();
  c.voice('idle'); c.toggle();
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  c.toggle();
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true, pinned: false });
  c.voice('speaking'); c.voice('idle');
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true, pinned: false });
  c.toggle(); assert.equal(c.snapshot().mode, 'chat');
  c.compose(); c.toggle(); assert.equal(c.snapshot().mode, 'peek');
});

test('collapse clears an old exit timeout and leaving still dismisses after a second', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.toggle(); c.hover('orb', false); advance(900);
  c.toggle(); advance(300);
  assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true, pinned: false });
  c.hover('orb', true); c.hover('orb', false); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});

test('click keeps chat open through the whole next voice cycle', () => {
  const { controller: c } = setup();
  c.hover('orb', true); c.open();
  for (const state of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'idle']) {
    c.voice(state);
    assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  }
});
test('starting another recording invalidates a previous hide timeout', () => {
  const { controller: c, advance } = setup();
  c.voice('speaking'); c.hover('orb', true); c.open(); c.hover('orb', false);
  advance(900); c.voice('listening'); advance(300);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
});
test('moving from orb into popup preserves chat, leaving both hides after a second', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.open(); c.hover('orb', false); advance(400);
  c.hover('panel', true); advance(800);
  assert.equal(c.snapshot().mode, 'chat');
  c.hover('panel', false); advance(999);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  advance(1); assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});
test('rapid reopen cancels an old timeout and hover never downgrades chat', () => {
  const { controller: c, advance } = setup();
  c.hover('orb', true); c.open(); c.hover('orb', false); advance(900);
  c.open(); c.hover('orb', true); c.open(false); advance(500);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
});
test('completion retains an untouched popup for two seconds and repeated snapshots do not reactivate windows', () => {
  const { controller: c, changes, advance } = setup();
  c.voice('listening'); assert.equal(c.snapshot().orbVisible, true);
  assert.equal(c.snapshot().mode, 'peek');
  c.voice('idle'); advance(1999);
  assert.equal(c.snapshot().orbVisible, true);
  advance(1); assert.equal(c.snapshot().orbVisible, false);
  c.hover('orb', true); c.open();
  const count = changes.length;
  c.voice('speaking'); c.voice('speaking'); c.voice('idle');
  assert.equal(changes.length, count);
});
test('native pointer tracking keeps a stationary cursor inside a resized popup', () => {
  const { controller: c, advance } = setup();
  const track = createPointerTracker((surface, entered) => c.hover(surface, entered));
  const orb = { x: 400, y: 500, width: 64, height: 80 };
  const panel = { x: 84, y: 300, width: 380, height: 192 };
  track({ x: 432, y: 532 }, { orb, panel: null }); c.open();
  track({ x: 100, y: 400 }, { orb, panel });
  c.voice('listening');
  track({ x: 100, y: 400 }, { orb, panel: { ...panel, y: 200, height: 292 } });
  advance(2000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  track({ x: 0, y: 0 }, { orb, panel }); advance(1000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  c.voice('idle');
  advance(2000);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});

for (const state of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']) {
  test(`leaving both surfaces during ${state} keeps the popup and orb visible`, () => {
    const { controller: c, advance } = setup();
    c.voice(state); c.hover('orb', true); c.hover('orb', false);
    advance(1000);
    assert.deepEqual(c.snapshot(), { mode: 'peek', orbVisible: true, pinned: false });
    advance(5000); c.voice(state);
    assert.equal(c.snapshot().orbVisible, true);
    c.dismiss();
    assert.equal(c.snapshot().mode, 'hidden', 'Explicit dismissal remains available');
    assert.equal(c.snapshot().orbVisible, true, 'Escape dismisses the popup, not active work');
    c.voice('idle');
    assert.equal(c.snapshot().orbVisible, false);
  });
}

test('hover departure survives state transitions and hides only after playback finishes', () => {
  const { controller: c, advance } = setup();
  c.voice('listening'); c.hover('orb', true); c.open(); c.hover('orb', false);
  advance(500); c.voice('transcribing'); advance(500);
  for (const state of ['thinking', 'preparing-speech', 'speaking']) {
    c.voice(state); advance(2000);
    assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  }
  c.voice('idle');
  advance(1999);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
  advance(1);
  assert.deepEqual(c.snapshot(), { mode: 'hidden', orbVisible: false, pinned: false });
});

test('text submission cancels an idle hover timeout before answer generation', () => {
  const { controller: c, advance } = setup();
  c.voice('idle'); c.compose(); c.hover('panel', true); c.hover('panel', false);
  advance(900); c.voice('thinking'); advance(2000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', orbVisible: true, pinned: false });
});

test('completion while hovered preserves the orb until a fresh departure timeout', () => {
  const { controller: c, advance } = setup();
  c.voice('speaking'); c.hover('orb', true); c.hover('orb', false); advance(2000);
  c.hover('orb', true); c.voice('idle'); advance(2000);
  assert.equal(c.snapshot().orbVisible, true);
  c.hover('orb', false); advance(999);
  assert.equal(c.snapshot().orbVisible, true);
  advance(1); assert.equal(c.snapshot().orbVisible, false);
});

test('completion starts a fresh two-second grace after departure during playback', () => {
  const { controller: c, advance } = setup();
  c.voice('speaking'); c.hover('orb', true); c.hover('orb', false);
  advance(500); c.voice('idle'); advance(1999);
  assert.equal(c.snapshot().orbVisible, true);
  advance(1); assert.equal(c.snapshot().orbVisible, false);
});

test('a new recording cancels completion grace and hover cannot shorten it', () => {
  const { controller: c, advance } = setup();
  c.voice('listening'); c.voice('speaking'); c.voice('idle');
  advance(500); c.hover('orb', true); c.hover('orb', false);
  advance(1000); assert.equal(c.snapshot().mode, 'peek');
  c.voice('listening'); advance(5000);
  assert.equal(c.snapshot().mode, 'peek');
  c.voice('idle'); advance(2000);
  assert.equal(c.snapshot().mode, 'hidden');
});
