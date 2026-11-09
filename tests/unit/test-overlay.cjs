const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayController } = require('../../electron/overlay-controller.cjs');

function setup() {
  let time = 0, id = 0;
  const tasks = new Map();
  const changes = [], presentations = [];
  const controller = createOverlayController({ onChange: (value, state) => { changes.push(value); presentations.push({ ...value, ...state }); }, timers: {
    setTimeout(callback, delay) { const key = ++id; tasks.set(key, { at: time + delay, callback }); return key; },
    clearTimeout(key) { tasks.delete(key); },
  } });
  return { controller, changes, presentations, advance(ms) {
    time += ms;
    for (const [key, task] of [...tasks]) if (task.at <= time) { tasks.delete(key); task.callback(); }
  } };
}


for (const [before, after] of [['hidden','compose'], ['compose','chat'], ['peek','compact'], ['compact','chat'], ['chat','compact']]) {
  test('tap transition ' + before + ' -> ' + after, () => {
    const {controller:c}=setup();
    if(before==='peek') c.intent('voice-input');
    if(before==='compose') c.compose();
    if(before==='chat') c.open();
    if(before==='compact') c.intent('text-input');
    c.compose(); assert.equal(c.snapshot().mode, after);
    assert.notEqual(c.snapshot().mode, 'hidden');
  });
}
for (const state of ['listening','transcribing','thinking','preparing-speech','speaking']) {
  test('Escape hides the panel throughout '+state, () => {
    const {controller:c,advance}=setup(); c.intent('voice-input'); c.voice(state);
    c.hover('panel',true); c.togglePin(); c.dismiss();
    assert.deepEqual(c.snapshot(),{mode:'hidden',pinned:false});
    c.hover('panel',true); c.voice(state); c.voice('speaking'); c.voice('idle'); advance(10000);
    assert.equal(c.snapshot().mode,'hidden');
  });
}
test('voice and text input preserve the expanded conversation', () => {
  const {controller:c}=setup(); c.compose(); c.open(); c.intent('voice-input'); c.voice('listening');
  assert.equal(c.snapshot().mode,'chat');
  for(const state of ['transcribing','thinking','preparing-speech','speaking']) c.voice(state);
  assert.equal(c.snapshot().mode,'chat');
  c.intent('text-input'); assert.equal(c.snapshot().mode,'chat');
  c.voice('idle'); assert.equal(c.snapshot().mode,'chat');
});
for (const mode of ['compose', 'compact', 'chat']) {
  test('voice recording preserves ' + mode + ' mode', () => {
    const { controller: c } = setup();
    if (mode === 'compose') c.compose();
    else if (mode === 'compact') c.intent('text-input');
    else c.open();
    c.intent('voice-input');
    for (const state of ['listening', 'transcribing', 'idle']) {
      c.voice(state);
      assert.equal(c.snapshot().mode, mode);
    }
  });
}
test('voice submission reveals its response after recording in input-only mode', () => {
  const { controller: c } = setup();
  c.compose(); c.intent('voice-input'); c.voice('listening'); c.voice('transcribing');
  assert.equal(c.snapshot().mode, 'compose');
  c.voice('thinking');
  assert.equal(c.snapshot().mode, 'compact');
});
test('correction and continuation retain expanded scope, otherwise add a compact composer', () => {
  for(const intent of ['correct','continue']) {
    const {controller:c}=setup(); c.open(); c.intent(intent); assert.equal(c.snapshot().mode,'chat');
    c.intent('voice-input'); c.intent(intent); assert.equal(c.snapshot().mode,'chat');
    c.intent(intent); assert.equal(c.snapshot().mode,'chat');
    c.dismiss(); c.intent(intent); assert.equal(c.snapshot().mode,'compose');
  }
});
test('completion lasts exactly five seconds and repeated idle does not renew it', () => {
  const {controller:c,advance}=setup(); c.voice('speaking'); c.voice('idle');
  advance(4999); c.voice('idle'); assert.notEqual(c.snapshot().mode,'hidden');
  advance(1); assert.deepEqual(c.snapshot(),{mode:'hidden',pinned:false});
});
for(const protection of ['hover','focus','pin']) {
  test(protection+' at expiry retains the panel even after protection is removed', () => {
    const {controller:c,advance}=setup(); c.intent('text-input'); c.voice('thinking'); c.voice('idle');
    if(protection==='hover') c.hover('panel',true);
    if(protection==='focus') c.composerFocus(true);
    if(protection==='pin') c.togglePin();
    advance(5000);
    c.hover('panel',false); c.composerFocus(false); if(protection==='pin') c.togglePin();
    advance(10000); assert.equal(c.snapshot().mode,'compact');
    c.dismiss(); assert.equal(c.snapshot().mode,'hidden');
  });
}
test('departure never starts a timer and a new operation cancels previous completion', () => {
  const {controller:c,advance}=setup(); c.compose(); c.hover('panel',true); c.hover('panel',false);
  advance(10000); assert.equal(c.snapshot().mode,'compose');
  c.intent('text-input'); c.voice('thinking'); c.voice('idle'); advance(4900);
  c.intent('voice-input'); c.voice('listening'); advance(10000); assert.equal(c.snapshot().mode,'compact');
  c.voice('idle'); advance(5000); assert.equal(c.snapshot().mode,'hidden');
});
test('errors persist, including when following an active operation', () => {
  const {controller:c,advance}=setup(); c.voice('thinking'); c.voice('error'); advance(10000);
  assert.equal(c.snapshot().mode,'peek'); c.dismiss(); c.voice('error'); assert.equal(c.snapshot().mode,'hidden');
});
test('external interaction preserves mode and pin and cancels stale completion timers', () => {
  const { controller: c, advance } = setup();
  c.open(); c.togglePin(); c.voice('thinking'); c.voice('idle');
  const release = c.hold();
  advance(10000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', pinned: true });
  release(); release();
  advance(10000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', pinned: true });
});
test('file-style holds keep the panel visible while preventing completion expiry', () => {
  const { controller: c, presentations, advance } = setup();
  c.open();
  const release = c.hold({ hide: false });
  c.voice('thinking'); c.voice('idle');
  advance(5000);
  assert.equal(c.snapshot().mode, 'chat');
  assert.equal(presentations.at(-1).suspended, false);
  release(false);
  advance(10000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', pinned: false });
});
test('nested interaction holds hide only while a hiding hold remains', () => {
  const { controller: c, presentations, advance } = setup();
  c.open(); c.togglePin();
  const visible = c.hold({ hide: false });
  const hiddenOne = c.hold();
  const hiddenTwo = c.hold({ hide: true });
  assert.equal(presentations.at(-1).suspended, true);
  hiddenOne(); hiddenOne();
  assert.equal(presentations.at(-1).suspended, true);
  hiddenTwo(false);
  assert.equal(presentations.at(-1).suspended, false);
  assert.equal(presentations.at(-1).focus, false, 'Remaining file-style hold does not steal focus');
  c.voice('thinking'); c.voice('idle'); advance(5000);
  assert.deepEqual(c.snapshot(), { mode: 'chat', pinned: true });
  visible();
  assert.equal(presentations.at(-1).suspended, false);
});
test('releasing a visible hold cannot reopen an explicitly dismissed panel', () => {
  const { controller: c, presentations } = setup();
  c.open(); const release = c.hold({ hide: false });
  c.dismiss(); release();
  assert.deepEqual(c.snapshot(), { mode: 'hidden', pinned: false });
  assert.equal(presentations.at(-1).mode, 'hidden');
});
