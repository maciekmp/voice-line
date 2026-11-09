const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { synchronizeRenderer } = require('../helpers/renderer-sync.cjs');

function fixture({ failSettings = false } = {}) {
  const listeners = { voice: new Set(), settings: new Set() };
  const subscribe = type => callback => {
    if (type === 'settings' && failSettings) throw new Error('Cannot subscribe');
    listeners[type].add(callback);
    return () => listeners[type].delete(callback);
  };
  const window = { voiceDesktop: { onVoice: subscribe('voice'), onSettings: subscribe('settings') }, rendered: '' };
  // Production listeners precede the receipt observer, just as in the real page.
  listeners.voice.add(value => { window.rendered = value.state; });
  const context = vm.createContext({ window, setTimeout, clearTimeout });
  const sent = [], evaluations = [];
  const webContents = {
    send(...args) { assert.equal(this, webContents); sent.push(args); return 'sent'; },
    executeJavaScript(...args) {
      assert.equal(this, webContents); evaluations.push(args);
      try { return Promise.resolve(vm.runInContext(args[0], context)); }
      catch (error) { return Promise.reject(error); }
    },
  };
  const originalSend = webContents.send, originalExecute = webContents.executeJavaScript;
  const deliver = (channel, value) => {
    const type = channel === 'voice:snapshot' ? 'voice' : channel === 'voice:visual-settings' ? 'settings' : undefined;
    if (type) for (const callback of listeners[type]) callback(value);
  };
  return { webContents, window, sent, evaluations, listeners, originalSend, originalExecute,
    deliver, deliverSent(index) { deliver(...sent[index]); } };
}

test('renderer reads wait for delivery and preserve payloads, arguments and method receivers', async t => {
  const f = fixture();
  const dispose = await synchronizeRenderer(f.webContents);
  t.after(dispose);
  const payload = { state: 'speaking', nested: { value: 'unchanged' } };
  assert.equal(f.webContents.send('voice:snapshot', payload, 'extra'), 'sent');
  assert.deepEqual(payload, { state: 'speaking', nested: { value: 'unchanged' } });
  assert.notEqual(f.sent[0][1], payload);
  assert.equal(f.sent[0][1].nested, payload.nested);
  assert.equal(f.sent[0][1].__smokeReceipt, 1);
  assert.equal(f.sent[0][2], 'extra');
  const result = f.webContents.executeJavaScript('window.rendered', true);
  assert.equal(f.evaluations.some(([code]) => code === 'window.rendered'), false);
  f.deliverSent(0);
  assert.equal(await result, 'speaking');
  assert.deepEqual(f.evaluations.at(-1), ['window.rendered', true]);
  const unknown = { untouched: true };
  f.webContents.send('other:channel', unknown, 42);
  assert.equal(f.sent[1][1], unknown);
  assert.deepEqual(f.sent[1], ['other:channel', unknown, 42]);
  f.webContents.send('other:without-payload');
  assert.deepEqual(f.sent[2], ['other:without-payload']);
});

test('untagged bootstrap events and out-of-order receipts cannot acknowledge missing messages', async t => {
  const f = fixture();
  const dispose = await synchronizeRenderer(f.webContents);
  t.after(dispose);
  f.webContents.send('voice:snapshot', { state: 'listening' });
  f.webContents.send('voice:visual-settings', { indicator: 'orb', paused: false });
  const result = f.webContents.executeJavaScript('window.rendered');
  f.deliver('voice:snapshot', { state: 'starting' });
  f.deliver('voice:visual-settings', { indicator: 'bars' });
  f.deliverSent(1);
  await Promise.resolve();
  assert.equal(f.evaluations.some(([code]) => code === 'window.rendered'), false);
  f.deliverSent(0);
  assert.equal(await result, 'listening');
});

test('missing receipts time out and cleanup restores methods and removes observers', async () => {
  const f = fixture();
  const dispose = await synchronizeRenderer(f.webContents, { timeoutMs: 10 });
  f.webContents.send('voice:visual-settings', { indicator: 'orb' });
  await assert.rejects(f.webContents.executeJavaScript('window.rendered'), /Timed out waiting for renderer IPC receipt 1 \(received 0\)/);
  await dispose();
  await dispose();
  assert.equal(f.webContents.send, f.originalSend);
  assert.equal(f.webContents.executeJavaScript, f.originalExecute);
  assert.equal(f.listeners.voice.size, 1);
  assert.equal(f.listeners.settings.size, 0);
  assert.equal(Object.hasOwn(f.window, '__voiceLineSmokeReceipts'), false);
});

test('failed setup cleans up an already-installed observer without replacing methods', async () => {
  const f = fixture({ failSettings: true });
  await assert.rejects(synchronizeRenderer(f.webContents), /Cannot subscribe/);
  assert.equal(f.webContents.send, f.originalSend);
  assert.equal(f.webContents.executeJavaScript, f.originalExecute);
  assert.equal(f.listeners.voice.size, 1);
  assert.equal(Object.hasOwn(f.window, '__voiceLineSmokeReceipts'), false);
});
