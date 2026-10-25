const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { MAX_IMAGE_BYTES } = require('./image-import.cjs');

function createChromiumImageDecoder({ BrowserWindow, ipcMain, root }) {
  return (bytes, mime, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const token = randomUUID();
    const window = new BrowserWindow({ show: false, skipTaskbar: true, width: 1, height: 1,
      webPreferences: { preload: join(root, 'image-decoder-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let finished = false;
    function done(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      ipcMain.removeListener('image-decoder:result', receive);
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error); else resolve(result);
    }
    const aborted = () => done(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
    const receive = (event, value) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || value?.token !== token) return;
      if (typeof value.png !== 'string' || value.png.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.png)) {
        done(new Error('Nie można odczytać obrazu lub przekracza on limit 32 MiB.')); return;
      }
      const output = Buffer.from(value.png, 'base64');
      if (output.length > MAX_IMAGE_BYTES || output.toString('base64') !== value.png) done(new Error('Nieprawidłowy obraz.'));
      else done(null, output);
    };
    const timer = setTimeout(() => done(new Error('Przekroczono czas odczytu obrazu.')), 15000);
    ipcMain.on('image-decoder:result', receive);
    signal?.addEventListener('abort', aborted, { once: true });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.on('closed', () => done(new Error('Przerwano odczyt obrazu.')));
    window.webContents.on('render-process-gone', () => done(new Error('Nie udało się odczytać obrazu.')));
    window.loadFile(join(root, 'image-decoder.html')).then(() => {
      if (!finished) window.webContents.send('image-decoder:source', { token, mime, base64: bytes.toString('base64') });
    }).catch(error => done(error));
  });
}
module.exports = { createChromiumImageDecoder };
