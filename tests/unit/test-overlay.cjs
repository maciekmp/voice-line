const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOverlayController } = require('../../electron/overlay-controller.cjs');

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
test('new voice and text intents choose mode without stealing voice focus', () => {
  const {controller:c}=setup(); c.compose(); c.open(); c.intent('voice-input'); c.voice('listening');
  assert.equal(c.snapshot().mode,'peek');
  for(const state of ['transcribing','thinking','preparing-speech','speaking']) c.voice(state);
  assert.equal(c.snapshot().mode,'peek');
  c.intent('text-input'); assert.equal(c.snapshot().mode,'compact');
  c.voice('idle'); assert.equal(c.snapshot().mode,'compact');
});
test('correction and continuation retain expanded scope, otherwise add a compact composer', () => {
  for(const intent of ['correct','continue']) {
    const {controller:c}=setup(); c.open(); c.intent(intent); assert.equal(c.snapshot().mode,'chat');
    c.intent('voice-input'); c.intent(intent); assert.equal(c.snapshot().mode,'compact');
    c.intent(intent); assert.equal(c.snapshot().mode,'compact');
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
  c.intent('voice-input'); c.voice('listening'); advance(10000); assert.equal(c.snapshot().mode,'peek');
  c.voice('idle'); advance(5000); assert.equal(c.snapshot().mode,'hidden');
});
test('errors persist, including when following an active operation', () => {
  const {controller:c,advance}=setup(); c.voice('thinking'); c.voice('error'); advance(10000);
  assert.equal(c.snapshot().mode,'peek'); c.dismiss(); c.voice('error'); assert.equal(c.snapshot().mode,'hidden');
});
