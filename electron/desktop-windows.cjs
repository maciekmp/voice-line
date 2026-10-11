const path = require('node:path');
const { createPointerTracker } = require('./overlay-pointer.cjs');

// Native surfaces, measurements, animation timers and display listeners.
// OverlayController decides visibility/mode; this adapter only applies it.
/** @param {{screen: Electron.Screen, BrowserWindow: typeof import('electron').BrowserWindow,
 * root: string, PANEL_MAX_HEIGHT: number, panelWindow?: Electron.BrowserWindow,
 * hover: (surface: 'panel', entered: boolean) => void,
 * exiting: () => boolean, dismiss: () => void}} host */
function createWindowAdapter(host) {
  const { screen, BrowserWindow, root, PANEL_MAX_HEIGHT } = host;
  let disposed = false;
  let removeDisplayListeners = () => {};
  const trackPointer = createPointerTracker((surface, entered) => host.hover(surface, entered));
  function samplePointer(cursor = screen.getCursorScreenPoint()) {
    const { panelWindow } = host;
    if (!panelWindow || panelWindow.isDestroyed()) return;
    trackPointer(cursor, { panel: panelWindow.isVisible() ? panelWindow.getBounds() : null });
  }


  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let panelResetTimer;
  /** @type {import('../src/desktop-contract.ts').PanelMode} */
  let panelMode = 'peek';
  let panelHeight = 80;
  const panelHeights = { peek: 80, chat: 140, compose: 66, compact: 122 };
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let panelResizeTimer;
  function positionPanel(animate = false) {
    const { panelWindow } = host;
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const marginX = Math.min(20, Math.max(0, (area.width - 1) / 2));
    const marginY = Math.min(20, Math.max(0, (area.height - 1) / 2));
    const width = Math.max(1, Math.min(380, area.width - marginX * 2));
    const availableHeight = Math.max(1, area.height - marginY * 2);
    const height = Math.max(1, Math.min(panelHeight, PANEL_MAX_HEIGHT, availableHeight));
    const bottom = area.y + area.height - marginY;
    const target = { x: Math.round(area.x + area.width - marginX - width),
      y: Math.round(bottom - height), width: Math.round(width), height: Math.round(height) };
    clearInterval(panelResizeTimer);
    const initial = panelWindow.getBounds();
    const done = () => {
      panelWindow.setBounds(target);
      panelWindow.webContents.send('voice:resizing', false);
    };
    if (!animate || Math.abs(initial.height - height) <= 2) { done(); return; }
    panelWindow.webContents.send('voice:resizing', true);
    const startedAt = Date.now();
    panelResizeTimer = setInterval(() => {
      if (panelWindow.isDestroyed()) { clearInterval(panelResizeTimer); return; }
      const progress = Math.min(1, (Date.now() - startedAt) / 220);
      const eased = 1 - (1 - progress) ** 3;
      const currentHeight = Math.min(availableHeight, Math.max(1, Math.round(initial.height + (height - initial.height) * eased)));
      panelWindow.setBounds({ ...target, y: Math.round(bottom - currentHeight), height: currentHeight });
      if (progress === 1) { clearInterval(panelResizeTimer); done(); }
    }, 16);
  }
  function renderHidePanel() {
    const { panelWindow } = host;
    clearInterval(panelResizeTimer);
    clearTimeout(panelResetTimer);
    panelWindow?.hide();
    // Let Windows finish hiding the native surface before changing its contents.
    panelResetTimer = setTimeout(() => {
      panelResetTimer = undefined;
      if (!panelWindow || panelWindow.isDestroyed() || panelWindow.isVisible()) return;
      panelMode = 'peek';
      panelHeight = panelHeights.peek;
      panelWindow.webContents.send('voice:mode', 'peek');
    }, 180);
  }
  /** @param {import('../src/desktop-contract.ts').PanelMode} mode @param {boolean} focus */
  function renderOpenPanel(mode, focus) {
    const { panelWindow } = host;
    if (!panelWindow || panelWindow.isDestroyed()) return;
    clearTimeout(panelResetTimer);
    panelResetTimer = undefined;
    const changed = panelMode !== mode;
    panelMode = mode;
    if (!panelWindow.isVisible()) panelHeight = panelHeights[panelMode];
    if (!changed || !panelWindow.isVisible()) positionPanel();
    if (focus) { panelWindow.show(); panelWindow.focus(); }
    else if (!panelWindow.isVisible()) panelWindow.showInactive();
    // Start native resizing immediately; renderer measurement refines the target.
    if (changed) {
      panelHeight = mode === 'chat' ? Math.max(panelHeights.chat, panelHeights.peek + 42) : panelHeights[mode];
      positionPanel(true);
    }
    panelWindow.webContents.send('voice:mode', panelMode);
  }

  return {
    create: async () => {
      if (disposed) return;
      host.panelWindow = new BrowserWindow({
        width: 380, height: 80, frame: false, skipTaskbar: true,
        resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        alwaysOnTop: true,
        title: 'Voice Line — rozmowa', show: false, backgroundColor: '#242220',
        webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      });
      const panelWindow = host.panelWindow;
      panelWindow.setMenu(null);
      panelWindow.setAlwaysOnTop(true, 'screen-saver');
      panelWindow.on('show', () => {
        panelWindow.setAlwaysOnTop(true, 'screen-saver');
        panelWindow.webContents.send('voice:visible', true);
      });
      panelWindow.on('hide', () => panelWindow.webContents.send('voice:visible', false));
      panelWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      const reposition = () => positionPanel();
      screen.on('display-metrics-changed', reposition);
      screen.on('display-added', reposition);
      screen.on('display-removed', reposition);
      removeDisplayListeners = () => {
        screen.removeListener('display-metrics-changed', reposition);
        screen.removeListener('display-added', reposition);
        screen.removeListener('display-removed', reposition);
      };
      positionPanel();
      panelWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      panelWindow.webContents.on('will-navigate', event => event.preventDefault());
      panelWindow.on('close', event => { if (!host.exiting()) { event.preventDefault(); host.dismiss(); } });
      await panelWindow.loadFile(path.join(root, 'conversation.html'));

    },
    positionPanel, openPanel: renderOpenPanel, hidePanel: renderHidePanel, samplePointer,
    get mode() { return panelMode; },
    get height() { return panelHeight; }, /** @param {number} value */ set height(value) { panelHeight = value; },
    get heights() { return panelHeights; },
    get resetTimer() { return panelResetTimer; },
    dispose() {
      disposed = true;
      clearTimeout(panelResetTimer);
      clearInterval(panelResizeTimer);
      removeDisplayListeners();
    },
  };
}
module.exports = { createWindowAdapter };
