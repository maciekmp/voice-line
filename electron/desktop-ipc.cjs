const { readImage } = require('./image-files.cjs');
const { writeAtomic } = require('./atomic-file.cjs');
const { parseDesktopRequest } = require('../src/desktop-validation.cjs');

// Register the narrow renderer boundary against injected native adapters.
// Window and worker getters stay current across shutdown and worker restarts.
function registerDesktopIpc(ipcMain, host) {
  const { clipboard, dialog, overlay, openPanel, hidePanel, positionPanel, sendVoice,
    sendSettings, imageDirectory, panelHeights, PANEL_MAX_HEIGHT, smokeTest, preview, engineSupervisor } = host;
  const listeners = [];
  const handlers = [];
  const normalize = (channel, callback, invalidResult) => (event, payload) => {
    const request = parseDesktopRequest(channel, payload);
    return request ? callback(event, 'value' in request ? request.value : undefined) : invalidResult;
  };
  const on = (channel, callback) => {
    const listener = normalize(channel, callback);
    ipcMain.on(channel, listener); listeners.push([channel, listener]);
  };
  const handle = (channel, callback) => {
    const invalidResult = channel === 'voice:image-preview' ? null : channel === 'voice:image-save' ? 'error' : false;
    ipcMain.handle(channel, normalize(channel, callback, invalidResult)); handlers.push(channel);
  };
  function trusted(event) {
    const window = host.panelWindow;
    return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
  }
  on('voice:open', event => {
    if (!trusted(event) || host.exitStarted) return;
    if (process.argv.includes('--debug')) console.log('[overlay] open request');
    openPanel();
  });
  on('voice:resize', (event, size) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents || host.exitStarted
      || !size || !Number.isFinite(size.height) || size.height < 0
      || !['peek', 'chat', 'compose', 'compact'].includes(size.mode) || size.mode !== host.panelMode) return;
    const measuredHeight = Math.max(64, Math.min(PANEL_MAX_HEIGHT, Math.ceil(size.height) + 2));
    // Preserve the expanded chat surface; compact peek always follows its content.
    host.panelHeight = size.mode === 'chat' && host.panelWindow.isVisible() && ['listening', 'transcribing', 'thinking'].includes(host.voice.state)
      ? Math.max(host.panelHeight, measuredHeight) : measuredHeight;
    panelHeights[size.mode] = host.panelHeight;
    if (host.panelResetTimer && !host.panelWindow.isVisible()) return;
    positionPanel();
  });
  handle('voice:copy-code', (event, text) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents
      || host.exitStarted || typeof text !== 'string') return false;
    try { clipboard.writeText(text); return true; }
    catch { return false; }
  });
  handle('voice:text', async (event, text) => {
    if (!trusted(event) || host.exitStarted || typeof text !== 'string' || !text.trim() || text.length > 12000
      || !host.engine?.connected) return false;
    const result = await host.engine.request({ command: 'text', text: text.trim() });
    return result.accepted;
  });
  handle('voice:image-preview', async (event, id) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents || host.exitStarted) return null;
    try { return `data:image/png;base64,${(await readImage(imageDirectory, id)).toString('base64')}`; }
    catch { return null; }
  });
  handle('voice:image-save', async (event, id) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents || host.exitStarted) return 'error';
    try {
      const bytes = await readImage(imageDirectory, id);
      const choice = await dialog.showSaveDialog(host.panelWindow, { title: 'Zapisz obraz', defaultPath: 'obraz',
        filters: [{ name: 'Obraz PNG', extensions: ['png'] }] });
      if (choice.canceled || !choice.filePath) return 'cancelled';
      await writeAtomic(choice.filePath, bytes);
      return 'saved';
    } catch { return 'error'; }
  });
  on('voice:hover', (event, entered) => {
    if (!trusted(event) || host.exitStarted || typeof entered !== 'boolean') return;
    // In production use a native cursor sample for the panel. Renderer
    // pointerleave can be caused by window resizing, not actual cursor movement.
    if (!smokeTest || host.testNativePointer) return;
    overlay.hover('panel', entered);
  });
  on('voice:composer-focus', (event, focused) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents || host.exitStarted) return;
    overlay.composerFocus(focused);
  });
  handle('voice:command', async (event, command) => {
    if (!trusted(event) || host.exitStarted) return false;
    if (command === 'pin' && event.sender === host.panelWindow?.webContents) { overlay.togglePin(); return true; }
    if (command === 'previous') {
      if (!host.engine?.connected) return false;
      const result = await host.engine.request({ command });
      if (result.accepted && !host.exitStarted) overlay.open();
      return result.accepted;
    }
    if (command === 'hide') { hidePanel(); return true; }
    if (command === 'retry') {
      if (smokeTest || preview) return false;
      await engineSupervisor.restart();
      return true;
    }
    if (['record', 'release', 'cancel', 'reset'].includes(command) && host.engine?.connected) return (await host.engine.request({ command })).accepted;
    return false;
  });
  on('voice:ready', event => {
    if (!trusted(event) || host.exitStarted) return;
    host.panelWindow.webContents.send('voice:pinned', overlay.snapshot().pinned);
    sendVoice();
    sendSettings();
    host.panelWindow.webContents.send('voice:visible', host.panelWindow.isVisible());
  });

  return () => {
    for (const [channel, callback] of listeners) ipcMain.removeListener(channel, callback);
    for (const channel of handlers) ipcMain.removeHandler(channel);
  };
}
module.exports = { registerDesktopIpc };
