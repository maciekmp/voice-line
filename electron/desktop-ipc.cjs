const { readImage } = require('./image-files.cjs');
const { writeAtomic } = require('./atomic-file.cjs');
const { parseDesktopRequest } = require('../src/desktop-validation.cjs');

// Register the narrow renderer boundary against injected native adapters.
// Window and worker getters stay current across shutdown and worker restarts.
function registerDesktopIpc(ipcMain, host) {
  const { clipboard, dialog, overlay, openPanel, hidePanel, positionPanel, sendVoice,
    finishExit, imageDirectory, panelHeights, PANEL_MAX_HEIGHT, smokeTest, preview, engineSupervisor } = host;
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
    return [host.orbWindow, host.panelWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  }
  on('voice:open', event => {
    if (!trusted(event) || host.exitStarted) return;
    if (process.argv.includes('--debug')) console.log('[overlay] open request');
    if (event.sender === host.orbWindow.webContents) {
      if (host.engine?.connected) host.engine.send({ command: 'tap' });
      else overlay.compose();
    }
    else openPanel();
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
    positionPanel(host.panelWindow.isVisible() && !size.reducedMotion);
  });
  handle('voice:copy-code', (event, text) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents
      || host.exitStarted || typeof text !== 'string') return false;
    try { clipboard.writeText(text); return true; }
    catch { return false; }
  });
  handle('voice:text', (event, text) => {
    if (!trusted(event) || host.exitStarted || typeof text !== 'string' || !text.trim() || text.length > 12000
      || !host.voice.ready || !host.engine?.connected || !['idle', 'error'].includes(host.voice.state)) return false;
    overlay.intent('text-input');
    sendVoice({ state: 'thinking', question: text.trim(), answer: '', questionSource: 'text' });
    host.engine.send({ command: 'text', text: text.trim() });
    return true;
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
    // In production use one native cursor sample for both surfaces. Renderer
    // pointerleave can be caused by window resizing, not actual cursor movement.
    if (!smokeTest || host.testNativePointer) return;
    overlay.hover(event.sender === host.orbWindow.webContents ? 'orb' : 'panel', entered);
  });
  on('voice:composer-focus', (event, focused) => {
    if (!host.panelWindow || host.panelWindow.isDestroyed() || event.sender !== host.panelWindow.webContents || host.exitStarted) return;
    overlay.composerFocus(focused);
  });
  on('voice:command', (event, command) => {
    if (!trusted(event) || host.exitStarted) return;
    if (command === 'pin' && event.sender === host.panelWindow?.webContents) { overlay.togglePin(); return; }
    if (command === 'previous') {
      if (event.sender !== host.panelWindow?.webContents || !host.voice.ready || !host.voice.canRestorePrevious
        || !['idle', 'error'].includes(host.voice.state) || !host.engine?.connected) return;
      sendVoice({ state: 'thinking' });
      host.engine.send({ command });
      overlay.open();
      return;
    }
    if (command === 'hide') { hidePanel(); return; }
    if (command === 'retry' && !host.voice.ready) {
      if (!smokeTest && !preview) void engineSupervisor.restart();
      return;
    }
    if (['record', 'release', 'cancel', 'reset'].includes(command) && host.engine?.connected) host.engine.send({ command });
  });
  on('orb:ready', event => {
    if (!trusted(event) || host.exitStarted) return;
    if (host.panelWindow && event.sender === host.panelWindow.webContents) {
      host.panelWindow.webContents.send('voice:pinned', overlay.snapshot().pinned);
      sendVoice(); return;
    }
    if (!host.orbWindow || event.sender !== host.orbWindow.webContents) return;
    if (smokeTest || preview) {
      host.orbWindow.showInactive();
      host.orbWindow.webContents.send('orb:presence', 'visible');
    }
    sendVoice();
  });
  on('orb:exit-complete', event => {
    if (host.orbWindow && event.sender === host.orbWindow.webContents && host.exitStarted) {
      host.exitAcknowledged = true;
      finishExit();
    }
  });

  return () => {
    for (const [channel, callback] of listeners) ipcMain.removeListener(channel, callback);
    for (const channel of handlers) ipcMain.removeHandler(channel);
  };
}
module.exports = { registerDesktopIpc };
