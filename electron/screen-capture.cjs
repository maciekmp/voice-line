const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: pause } = require('node:timers/promises');

// The selector speaks DIP coordinates. Use the actual bitmap dimensions, since
// desktopCapturer does not guarantee the requested thumbnailSize (or DPI).
function cropRectangle(rect, bounds, size) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > bounds.width + .01 || rect.y + rect.height > bounds.height + .01
    || bounds.width <= 0 || bounds.height <= 0 || size.width <= 0 || size.height <= 0) return null;
  const x = Math.max(0, Math.floor(rect.x * size.width / bounds.width));
  const y = Math.max(0, Math.floor(rect.y * size.height / bounds.height));
  const right = Math.min(size.width, Math.ceil((rect.x + rect.width) * size.width / bounds.width));
  const bottom = Math.min(size.height, Math.ceil((rect.y + rect.height) * size.height / bounds.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function waitForCapture(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => finish(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(new Error('Przekroczono czas przechwytywania ekranu.')), 15000);
    function finish(error, value) {
      clearTimeout(timer); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

function createScreenCapture({ BrowserWindow, desktopCapturer, screen, ipcMain, root }) {
  let active;
  function cancel() { if (active) { active.cancelled = true; active.abort.abort(); active.finish?.(null); } }
  return {
    cancel,
    async capture(signal) {
      if (active || signal?.aborted) return null;
      const job = { windows: [], token: randomUUID(), cancelled: false, finish: null, abort: new AbortController() };
      active = job;
      let finishSelection, receive;
      const aborted = () => { job.cancelled = true; job.abort.abort(); job.finish?.(null); };
      signal?.addEventListener('abort', aborted, { once: true });
      const changed = () => aborted();
      for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, changed);
      try {
        // Give DWM time to remove the hidden panel before reading desktop pixels.
        await pause(60, undefined, { signal: job.abort.signal });
        const displays = screen.getAllDisplays();
        if (!displays.length) throw new Error('Nie znaleziono ekranu do zaznaczenia.');
        const thumbnailSize = { width: Math.max(...displays.map(display => Math.ceil(display.bounds.width * display.scaleFactor))),
          height: Math.max(...displays.map(display => Math.ceil(display.bounds.height * display.scaleFactor))) };
        const sources = await waitForCapture(desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false }), job.abort.signal);
        if (job.cancelled || signal?.aborted) return null;
        const selection = new Promise(resolve => { finishSelection = resolve; job.finish = resolve; });
        const frames = new Map();
        receive = (event, value) => {
          if (active !== job || value?.token !== job.token) return;
          const frame = frames.get(event.sender);
          if (!frame || event.senderFrame !== event.sender.mainFrame) return;
          if (value.cancel === true) { finishSelection(null); return; }
          const rect = cropRectangle(value.rect, frame.display.bounds, frame.image.getSize());
          if (!rect) return;
          finishSelection(frame.image.crop(rect).toPNG());
        };
        ipcMain.on('screen-capture:selection', receive);
        for (const display of displays) {
          const source = sources.find(candidate => candidate.display_id === String(display.id));
          if (!source || source.thumbnail.isEmpty()) throw new Error('Nie można odczytać zawartości ekranu.');
          const window = new BrowserWindow({ ...display.bounds, frame: false, show: false, skipTaskbar: true,
            resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
            alwaysOnTop: true, backgroundColor: '#151515', enableLargerThanScreen: true,
            webPreferences: { preload: join(root, 'screen-selector-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          job.windows.push(window);
          frames.set(window.webContents, { display, image: source.thumbnail });
          window.setMenu(null); window.setAlwaysOnTop(true, 'screen-saver');
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          window.webContents.on('will-navigate', event => event.preventDefault());
          window.on('closed', () => job.finish?.(null));
          window.on('blur', () => setTimeout(() => {
            if (active === job && !job.windows.some(candidate => !candidate.isDestroyed() && candidate.isFocused())) aborted();
          }, 50));
          window.webContents.on('render-process-gone', () => job.finish?.(null));
          await waitForCapture(window.loadFile(join(root, 'screen-selector.html')), job.abort.signal);
          if (job.cancelled || signal?.aborted) return null;
          window.webContents.send('screen-capture:frame', { token: job.token, image: `data:image/png;base64,${source.thumbnail.toPNG().toString('base64')}` });
        }
        if (job.cancelled || signal?.aborted) return null;
        const pointerDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        for (const window of job.windows) window.showInactive();
        const focus = job.windows[displays.findIndex(display => display.id === pointerDisplay.id)] || job.windows[0];
        focus?.show(); focus?.focus();
        return await selection;
      } catch (error) {
        if (error.name === 'AbortError' || job.cancelled) return null;
        throw error;
      } finally {
        signal?.removeEventListener('abort', aborted);
        for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, changed);
        if (receive) ipcMain.removeListener('screen-capture:selection', receive);
        job.finish = null;
        for (const window of job.windows) if (!window.isDestroyed()) window.destroy();
        if (active === job) active = undefined;
      }
    },
  };
}
module.exports = { createScreenCapture, cropRectangle };
