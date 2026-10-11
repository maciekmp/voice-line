const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowAdapter } = require('../../electron/desktop-windows.cjs');
const { createOverlayController } = require('../../electron/overlay-controller.cjs');

function fixture(options = {}) {
  const created = [], hover = [];
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.bounds = { x: 1000, y: 700, ...settings };
      this.visible = false; this.destroyed = false; this.focused = false; this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (...args) => this.messages.push(args);
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      this.webContents.session = { setPermissionRequestHandler: callback => { this.permissionHandler = callback; } };
      created.push(this);
    }
    setMenu() {} setAlwaysOnTop() {}
    getBounds() { const { x, y, width, height } = this.bounds; return { x, y, width, height }; }
    setBounds(value) { this.bounds = value; }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    async loadFile(filename) { this.filename = filename; await options.load?.(filename); }
  }
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: 1032, y: 732 });
  screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } });
  let dismissed = 0;
  const host = { screen, BrowserWindow: Window, root: '/fixture',
    PANEL_MAX_HEIGHT: 500, hover: (...value) => hover.push(value),
    exiting: () => false, dismiss: () => dismissed++ };
  const adapter = createWindowAdapter(host);
  return { host, adapter, created, hover, dismissed: () => dismissed };
}

test('native adapter preserves window isolation, blocks navigation and removes display listeners', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.create();
  assert.equal(f.created.length, 1);
  for (const window of f.created) {
    assert.equal(window.settings.webPreferences.sandbox, true);
    assert.equal(window.settings.webPreferences.nodeIntegration, false);
    assert.equal(window.settings.webPreferences.contextIsolation, true);
    assert.deepEqual(window.openHandler(), { action: 'deny' });
    let prevented = false;
    window.webContents.emit('will-navigate', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  f.host.panelWindow.emit('close', { preventDefault() {} });
  assert.equal(f.dismissed(), 1);
  f.host.exiting = () => true;
  f.host.panelWindow.emit('close', { preventDefault() { assert.fail('shutdown close must proceed'); } });
  const unrelated = () => {};
  f.host.screen.on('display-added', unrelated);
  f.adapter.dispose();
  assert.deepEqual(f.host.screen.listeners('display-added'), [unrelated]);
  assert.equal(f.host.screen.listenerCount('display-removed'), 0);
});

test('native hover samples the current surface geometry after resize and display reposition', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.create();
  f.host.panelWindow.showInactive();
  f.adapter.height = 200;
  f.adapter.positionPanel();
  assert.deepEqual(f.host.panelWindow.getBounds(), { x: 800, y: 580, width: 380, height: 200 });
  f.adapter.samplePointer({ x: 900, y: 600 });
  assert.deepEqual(f.hover, [['panel', true]]);
  f.adapter.height = 80; f.adapter.positionPanel();
  f.adapter.samplePointer({ x: 900, y: 600 });
  assert.deepEqual(f.hover.at(-1), ['panel', false]);
  f.host.screen.getPrimaryDisplay = () => ({ workArea: { x: -800, y: -200, width: 320, height: 180 } });
  f.adapter.height = 500;
  f.host.screen.emit('display-metrics-changed');
  assert.deepEqual(f.host.panelWindow.getBounds(), { x: -780, y: -180, width: 280, height: 140 });
  f.adapter.samplePointer({ x: -700, y: -100 });
  assert.deepEqual(f.hover.at(-1), ['panel', true]);
  f.host.panelWindow.hide(); f.adapter.samplePointer({ x: -700, y: -100 });
  assert.deepEqual(f.hover.at(-1), ['panel', false]);
});

test('native adapter cancels hide and resize timers on disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = fixture(); await f.adapter.create();
  f.adapter.openPanel('chat', true);
  assert.equal(f.host.panelWindow.focused, true);
  f.adapter.hidePanel();
  f.adapter.dispose();
  const messages = f.host.panelWindow.messages.length;
  t.mock.timers.tick(1000);
  assert.equal(f.host.panelWindow.messages.length, messages);
  assert.equal(f.adapter.mode, 'chat', 'Disposed hide timer cannot reset the popup contents');
});

test('native close dismisses a pinned panel and preserves windows for reopening', async t => {
  for (const surface of ['panelWindow']) {
    const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.create();
    const overlay = createOverlayController({ onChange(value) {
      if (value.mode !== 'hidden') f.adapter.openPanel(value.mode, false);
      else f.adapter.hidePanel();
    } });
    t.after(() => overlay.dispose());
    f.host.dismiss = () => overlay.dismiss();
    overlay.open(); overlay.togglePin();
    assert.equal(overlay.snapshot().pinned, true);
    let prevented = false;
    f.host[surface].emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true, `${surface}: native destruction must be prevented`);
    assert.deepEqual(overlay.snapshot(), { mode: 'hidden', pinned: false });
    assert.equal(f.host.panelWindow.isVisible(), false);
    overlay.open();
    assert.equal(f.host.panelWindow.isVisible(), true);
    f.host.exiting = () => true;
    f.host[surface].emit('close', { preventDefault() { assert.fail('Application exit must allow window destruction'); } });
  }
});

test('shutdown during panel loading removes display listeners', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ load: () => gate });
  const startup = f.adapter.create();
  assert.equal(f.created.length, 1);
  f.adapter.dispose(); release(); await startup;
  assert.equal(f.created.length, 1);
  assert.equal(f.host.screen.listenerCount('display-added'), 0);
});
