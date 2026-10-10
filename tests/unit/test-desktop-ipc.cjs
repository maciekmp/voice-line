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
    orbWindow: window(), panelWindow: window(), exitStarted: false,
    voice: { ready: true, state: 'idle', canRestorePrevious: true },
    engine: { connected: true, send: message => sent.push(message) },
    sendVoice: update => updates.push(update),
    engineSupervisor: { restart() { retries++; } },
    overlay: { open() {}, togglePin() {}, toggle() {}, hover() {}, snapshot: () => ({ pinned: false }) },
    openPanel() {}, hidePanel() {}, finishExit() {},
    panelMode: 'chat', panelHeight: 100, panelHeights: { chat: 100 },
    PANEL_MAX_HEIGHT: 500, positionPanel() {},
    ...options,
  };
  const dispose = registerDesktopIpc(ipc, host);
  const event = () => ({ sender: host.panelWindow.webContents });
  return { ipc, handlers, host, sent, updates, dispose, event, retries: () => retries };
}

test('desktop text boundary validates sender, readiness, size and worker connectivity', () => {
  const { handlers, host, event, sent, updates } = setup();
  const text = handlers.get('voice:text');
  for (const value of ['', '   ', null, 42, 'a'.repeat(12001)]) assert.equal(text(event(), value), false);
  assert.equal(text({ sender: {} }, 'question'), false);
  host.voice.state = 'speaking';
  assert.equal(text(event(), 'question'), false);
  host.voice.state = 'idle';
  host.engine.connected = false;
  assert.equal(text(event(), 'question'), false);
  host.engine.connected = true;
  host.voice.ready = false;
  assert.equal(text(event(), 'question'), false);
  host.voice.ready = true;
  assert.equal(text(event(), '  pytanie\n'), true);
  assert.deepEqual(sent, [{ command: 'text', text: 'pytanie' }]);
  assert.deepEqual(updates, [{ state: 'thinking', question: 'pytanie', answer: '' }]);
});

test('desktop uses the current worker after restart and drops commands during shutdown', () => {
  const { ipc, host, sent, event } = setup();
  const replacement = [];
  ipc.emit('voice:command', event(), 'record');
  host.engine = { connected: true, send: message => replacement.push(message) };
  ipc.emit('voice:command', event(), 'cancel');
  ipc.emit('voice:command', event(), { command: 'reset' });
  ipc.emit('voice:command', { sender: {} }, 'reset');
  host.exitStarted = true;
  ipc.emit('voice:command', event(), 'reset');
  assert.deepEqual(sent, [{ command: 'record' }]);
  assert.deepEqual(replacement, [{ command: 'cancel' }]);
});

test('retry invokes the production supervisor only while services are unavailable', () => {
  const { ipc, host, event, retries } = setup();
  ipc.emit('voice:command', event(), 'retry');
  assert.equal(retries(), 0);
  host.voice.ready = false;
  ipc.emit('voice:command', event(), 'retry');
  assert.equal(retries(), 1);
  host.exitStarted = true;
  ipc.emit('voice:command', event(), 'retry');
  assert.equal(retries(), 1);
  for (const options of [{ smokeTest: true }, { preview: true }]) {
    const isolated = setup(options);
    isolated.host.voice.ready = false;
    isolated.ipc.emit('voice:command', isolated.event(), 'retry');
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
  assert.equal(ipc.listenerCount('orb:ready'), 0);
  assert.equal(handlers.size, 0);
});
