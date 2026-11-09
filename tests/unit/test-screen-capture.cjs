const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createScreenCapture, cropRectangle } = require('../../electron/screen-capture.cjs');

test('crop coordinates follow actual bitmap dimensions independently of requested DPI', () => {
  assert.deepEqual(cropRectangle({ x: 10, y: 20, width: 100, height: 80 }, { width: 800, height: 600 }, { width: 1600, height: 1200 }),
    { x: 20, y: 40, width: 200, height: 160 });
  assert.deepEqual(cropRectangle({ x: 799, y: 599, width: 1, height: 1 }, { width: 800, height: 600 }, { width: 1000, height: 750 }),
    { x: 998, y: 748, width: 2, height: 2 });
  for (const rect of [null, { x: -1, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 801, height: 1 },
    { x: 0, y: 0, width: 1, height: NaN }, { x: 0, y: 0, width: 0, height: 2 }]) {
    assert.equal(cropRectangle(rect, { width: 800, height: 600 }, { width: 1600, height: 1200 }), null);
  }
});

function setup() {
  const windows = [], crops = [], ipcMain = new EventEmitter(), screen = new EventEmitter();
  const displays = [
    { id: 10, bounds: { x: -800, y: 0, width: 800, height: 600 }, scaleFactor: 1.25 },
    { id: 20, bounds: { x: 0, y: 0, width: 1000, height: 800 }, scaleFactor: 2 },
  ];
  Object.assign(screen, { getAllDisplays: () => displays, getCursorScreenPoint: () => ({ x: 10, y: 10 }), getDisplayNearestPoint: () => displays[1] });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.focused = false; this.sent = [];
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, value) => this.sent.push({ channel, value });
      windows.push(this);
    }
    setMenu() {} setAlwaysOnTop() {} async loadFile() {} showInactive() {}
    show() { this.focused = true; } focus() { this.focused = true; } isFocused() { return this.focused; }
    isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const image = (id, size) => ({ isEmpty: () => false, getSize: () => size, toPNG: () => Buffer.from(`screen-${id}`),
    crop(rect) { crops.push({ id, rect }); return { toPNG: () => Buffer.from(`crop-${id}`) }; } });
  const desktopCapturer = { async getSources() { return [
    { display_id: '20', thumbnail: image(20, { width: 1500, height: 1200 }) },
    { display_id: '10', thumbnail: image(10, { width: 1000, height: 750 }) },
  ]; } };
  const capture = createScreenCapture({ BrowserWindow: Window, desktopCapturer, screen, ipcMain, root: 'synthetic' });
  return { capture, windows, crops, ipcMain, screen, desktopCapturer };
}
async function selectors(windows) {
  for (let i = 0; i < 100 && windows.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(windows.length, 2);
  await new Promise(resolve => setImmediate(resolve));
}

test('mixed DPI displays match by ID; only a bound selector may crop and all windows close', async () => {
  const { capture, windows, ipcMain, crops } = setup();
  const pending = capture.capture(); await selectors(windows);
  assert.equal(windows[0].options.x, -800);
  const window = windows[1], token = window.sent[0].value.token;
  const rect = { x: 100, y: 200, width: 200, height: 100 };
  ipcMain.emit('screen-capture:selection', { sender: {} }, { token, rect });
  ipcMain.emit('screen-capture:selection', { sender: window.webContents, senderFrame: {} }, { token, rect });
  ipcMain.emit('screen-capture:selection', { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { token: 'stale', rect });
  assert.deepEqual(crops, []);
  ipcMain.emit('screen-capture:selection', { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { token, rect });
  assert.deepEqual(await pending, Buffer.from('crop-20'));
  assert.deepEqual(crops, [{ id: 20, rect: { x: 150, y: 300, width: 300, height: 150 } }]);
  assert.ok(windows.every(window => window.destroyed));
  assert.equal(ipcMain.listenerCount('screen-capture:selection'), 0);
});

test('Escape, display changes and abort cancel without retaining screen pixels', async t => {
  for (const reason of ['escape', 'display', 'abort']) await t.test(reason, async () => {
    const { capture, windows, ipcMain, screen, crops } = setup(), abort = new AbortController();
    const pending = capture.capture(abort.signal); await selectors(windows);
    const window = windows[0], token = window.sent[0].value.token;
    if (reason === 'escape') ipcMain.emit('screen-capture:selection', { sender: window.webContents, senderFrame: window.webContents.mainFrame }, { token, cancel: true });
    if (reason === 'display') screen.emit('display-metrics-changed');
    if (reason === 'abort') abort.abort();
    assert.equal(await pending, null);
    assert.deepEqual(crops, []);
    assert.ok(windows.every(window => window.destroyed));
    assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  });
});
test('cancellation restores the app even when native screen acquisition never settles', async () => {
  const { capture, desktopCapturer, windows } = setup(), abort = new AbortController();
  desktopCapturer.getSources = () => new Promise(() => {});
  const pending = capture.capture(abort.signal);
  await new Promise(resolve => setTimeout(resolve, 80));
  abort.abort();
  assert.equal(await pending, null);
  assert.deepEqual(windows, []);
});
