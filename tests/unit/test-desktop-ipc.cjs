const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerDesktopIpc } = require('../../electron/desktop-ipc.cjs');

function setup(options = {}) {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (channel, callback) => handlers.set(channel, callback);
  ipc.removeHandler = channel => handlers.delete(channel);
  const window = () => ({ webContents: { send() {} }, isDestroyed: () => false, isVisible: () => true });
  const sent = [];
  const updates = [];
  let retries = 0;
  const host = {
    panelWindow: window(), exitStarted: false,
    voice: { ready: true, state: 'idle', canRestorePrevious: true },
    engine: { connected: true, request: async message => { sent.push(message); return { accepted: true, operationId: 1 }; } },
    sendVoice: update => updates.push(update),
    engineSupervisor: { restart() { retries++; } },
    overlay: { intent() {}, compose() {}, open() {}, togglePin() {}, toggle() {}, hover() {}, snapshot: () => ({ pinned: false }) },
    openPanel() {}, hidePanel() {}, sendSettings() {},
    panelMode: 'chat', panelHeight: 100, panelHeights: { chat: 100 },
    PANEL_MAX_HEIGHT: 500, positionPanel() {},
    ...options,
  };
  const dispose = registerDesktopIpc(ipc, host);
  const event = () => ({ sender: host.panelWindow.webContents });
  const command = (sender, value) => handlers.get('voice:command')(sender, value);
  return { ipc, handlers, command, host, sent, updates, dispose, event, retries: () => retries };
}

test('composer focus accepts only boolean reports from the live conversation renderer', () => {
  const { ipc, host, event } = setup();
  const reports = [];
  host.overlay.composerFocus = value => reports.push(value);
  ipc.emit('voice:composer-focus', event(), true);
  ipc.emit('voice:composer-focus', event(), false);
  ipc.emit('voice:composer-focus', event(), 'true');
  ipc.emit('voice:composer-focus', { sender: {} }, true);
  ipc.emit('voice:composer-focus', { sender: {} }, true);
  host.panelWindow.isDestroyed = () => true;
  ipc.emit('voice:composer-focus', event(), true);
  host.panelWindow.isDestroyed = () => false;
  host.exitStarted = true;
  ipc.emit('voice:composer-focus', event(), true);
  assert.deepEqual(reports, [true, false]);
});

test('only the live panel can open the conversation or receive initial settings', () => {
  let opened = 0, settings = 0;
  const { ipc, event, updates } = setup({ openPanel: () => opened++, sendSettings: () => settings++ });
  ipc.emit('voice:open', { sender: {} });
  ipc.emit('voice:open', event());
  assert.equal(opened, 1);
  ipc.emit('voice:ready', { sender: {} });
  assert.equal(settings, 0);
  ipc.emit('voice:ready', event());
  assert.equal(settings, 1); assert.equal(updates.length, 1);
});

test('desktop text boundary validates sender and waits for authoritative admission', async () => {
  const { handlers, host, event, sent, updates } = setup();
  const text = handlers.get('voice:text');
  for (const value of ['', '   ', null, 42, 'a'.repeat(12001)]) assert.equal(await text(event(), value), false);
  assert.equal(await text({ sender: {} }, 'question'), false);
  host.engine.connected = false;
  assert.equal(await text(event(), 'question'), false);
  host.engine.connected = true;
  let respond;
  host.engine.request = message => { sent.push(message); return new Promise(resolve => { respond = resolve; }); };
  const response = text(event(), '  pytanie\n');
  let settled = false; response.then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  assert.deepEqual(updates, [], 'The host cannot invent a thinking state');
  respond({ accepted: true, operationId: 1 });
  assert.equal(await response, true);
  assert.deepEqual(sent, [{ command: 'text', text: 'pytanie' }]);
  host.engine.request = async () => ({ accepted: false, reason: 'busy' });
  assert.equal(await text(event(), 'rejected'), false);
});

test('desktop uses the current worker after restart and drops commands during shutdown', () => {
  const { command, host, sent, event } = setup();
  const replacement = [];
  command(event(), 'record');
  host.engine = { connected: true, request: async message => { replacement.push(message); return { accepted: true, operationId: null }; } };
  command(event(), 'cancel');
  command(event(), { command: 'reset' });
  command({ sender: {} }, 'reset');
  host.exitStarted = true;
  command(event(), 'reset');
  assert.deepEqual(sent, [{ command: 'record' }]);
  assert.deepEqual(replacement, [{ command: 'cancel' }]);
});

test('desktop forwards selected image IDs but rejects paths and malformed attachment requests', async () => {
  const { handlers, event, sent } = setup();
  const send = handlers.get('voice:text');
  const imageId = 'a'.repeat(64);
  assert.equal(await send(event(), { text: '  Zmień tło  ', imageId }), true);
  assert.deepEqual(sent, [{ command: 'text', text: 'Zmień tło', imageId }]);
  for (const value of [{ text: 'edit', imageId: '../secret' }, { text: 'edit', imageId: 1 }, { text: '', imageId }]) {
    assert.equal(await send(event(), value), false);
  }
  assert.equal(sent.length, 1);
});

test('image selection reaches the worker independently of text and validates its sender and ID', async () => {
  const { handlers, event, sent } = setup();
  const select = handlers.get('voice:image-selection');
  const imageId = 'a'.repeat(64);
  assert.equal(await select({ sender: {} }, imageId), false);
  assert.equal(await select(event(), '../secret'), false);
  assert.equal(await select(event(), imageId), true);
  assert.equal(await select(event(), null), true);
  assert.deepEqual(sent, [{ command: 'select-image', imageId }, { command: 'select-image', imageId: null }]);
});

test('retry restarts production services also when only audio is unavailable', () => {
  const { command, host, event, retries } = setup();
  command(event(), 'retry');
  assert.equal(retries(), 1);
  host.voice.ready = false;
  command(event(), 'retry');
  assert.equal(retries(), 2);
  host.exitStarted = true;
  command(event(), 'retry');
  assert.equal(retries(), 2);
  for (const options of [{ smokeTest: true }, { preview: true }]) {
    const isolated = setup(options);
    isolated.host.voice.ready = false;
    isolated.command(isolated.event(), 'retry');
    assert.equal(isolated.retries(), 0);
  }
});

test('resize rejects obsolete mode and invalid measurements while retaining active hover geometry', () => {
  const { ipc, host, event } = setup();
  for (const height of [NaN, Infinity, -1, '100']) ipc.emit('voice:resize', event(), { mode: 'chat', height, reducedMotion: false });
  ipc.emit('voice:resize', event(), { mode: 'peek', height: 300, reducedMotion: false });
  assert.equal(host.panelHeight, 100);
  ipc.emit('voice:resize', event(), { mode: 'chat', height: 2000, reducedMotion: false });
  assert.equal(host.panelHeight, 500);
  host.voice.state = 'listening';
  ipc.emit('voice:resize', event(), { mode: 'chat', height: 70, reducedMotion: false });
  assert.equal(host.panelHeight, 500);
  host.voice.state = 'idle';
  ipc.emit('voice:resize', event(), { mode: 'chat', height: 70, reducedMotion: false });
  assert.equal(host.panelHeight, 72);
});

test('IPC disposal removes only the registered listeners and invocation handlers', () => {
  const { ipc, handlers, dispose } = setup();
  const unrelated = () => {};
  ipc.on('voice:command', unrelated);
  dispose();
  dispose();
  assert.deepEqual(ipc.listeners('voice:command'), [unrelated]);
  assert.equal(ipc.listenerCount('voice:ready'), 0);
  assert.equal(handlers.size, 0);
});

test('compact popup shrinks to current content throughout the next voice cycle', () => {
  const { ipc, host, event } = setup({ panelMode: 'peek', panelHeight: 400, panelHeights: { peek: 400 } });
  for (const state of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking', 'idle']) {
    host.voice.state = state;
    ipc.emit('voice:resize', event(), { mode: 'peek', height: 300, reducedMotion: false });
    assert.equal(host.panelHeight, 302, `${state}: grows to fit content`);
    ipc.emit('voice:resize', event(), { mode: 'peek', height: 40, reducedMotion: false });
    assert.equal(host.panelHeight, 64, `${state}: drops previous answer height`);
    assert.equal(host.panelHeights.peek, 64, `${state}: reopening uses the updated height`);
  }
});
