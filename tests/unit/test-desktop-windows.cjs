const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowAdapter } = require('../../electron/desktop-windows.cjs');

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
  screen.getDisplayMatching = () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } });
  let dismissed = 0;
  let location = { x: 1000, y: 700 };
  const host = { screen, BrowserWindow: Window, root: '/fixture', position: () => location,
    PANEL_MAX_HEIGHT: 500, hover: (...value) => hover.push(value), menu: () => ({ popup() {} }),
    exiting: () => false, dismiss: () => dismissed++ };
  const adapter = createWindowAdapter(host);
  return { host, adapter, created, hover, dismissed: () => dismissed, relocate: value => { location = value; } };
}

test('native adapter preserves window isolation, blocks navigation and removes display listeners', async t => {
  const f = fixture(); t.after(() => f.adapter.dispose()); await f.adapter.create();
  assert.equal(f.created.length, 2);
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
  f.host.orbWindow.showInactive(); f.host.panelWindow.showInactive();
  f.adapter.height = 200;
  f.adapter.positionPanel();
  assert.deepEqual(f.host.panelWindow.getBounds(), { x: 684, y: 492, width: 380, height: 200 });
  f.adapter.samplePointer({ x: 700, y: 600 });
  assert.deepEqual(f.hover, [['panel', true]]);
  f.adapter.height = 80; f.adapter.positionPanel();
  f.adapter.samplePointer({ x: 700, y: 600 });
  assert.deepEqual(f.hover.at(-1), ['panel', false]);
  f.relocate({ x: 500, y: 500 });
  f.host.screen.emit('display-metrics-changed');
  assert.deepEqual(f.host.orbWindow.getBounds(), { x: 500, y: 500, width: 64, height: 80 });
  assert.deepEqual(f.host.panelWindow.getBounds(), { x: 184, y: 412, width: 380, height: 80 });
  f.adapter.samplePointer({ x: 532, y: 532 });
  assert.deepEqual(f.hover.at(-1), ['orb', true]);
  f.host.orbWindow.hide(); f.adapter.samplePointer({ x: 532, y: 532 });
  assert.deepEqual(f.hover.at(-1), ['orb', false]);
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

test('shutdown during orb loading prevents creation of a late panel', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ load: () => gate });
  const startup = f.adapter.create();
  assert.equal(f.created.length, 1);
  f.adapter.dispose(); release(); await startup;
  assert.equal(f.created.length, 1);
  assert.equal(f.host.screen.listenerCount('display-added'), 0);
});
