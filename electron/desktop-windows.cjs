const path = require('node:path');
const { createPointerTracker } = require('./overlay-pointer.cjs');

// Native surfaces, measurements, hide timers and display listeners.
// OverlayController decides visibility/mode; this adapter only applies it.
/** @param {{screen: Electron.Screen, BrowserWindow: typeof import('electron').BrowserWindow,
 * root: string, PANEL_MAX_HEIGHT: number, panelWindow?: Electron.BrowserWindow, Menu?: typeof import('electron').Menu,
 * hover: (surface: 'panel', entered: boolean) => void,
 * exiting: () => boolean, dismiss: () => void}} host */
function createWindowAdapter(host) {
  const { screen, BrowserWindow, root, PANEL_MAX_HEIGHT } = host;
  const Menu = host.Menu || require('electron').Menu;
  let disposed = false;
  let removeDisplayListeners = () => {};
  const trackPointer = createPointerTracker((surface, entered) => host.hover(surface, entered));
  function samplePointer(cursor = screen.getCursorScreenPoint()) {
    const { panelWindow } = host;
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const bounds = panelWindow.getBounds();
    const height = Math.min(panelHeight, bounds.height);
    trackPointer(cursor, { panel: panelWindow.isVisible() ? { ...bounds, y: bounds.y + bounds.height - height, height } : null });
  }


  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let panelResetTimer;
  /** @type {import('../src/desktop-contract.ts').PanelMode} */
  let panelMode = 'peek';
  let panelHeight = 80;
  const panelHeights = { peek: 80, chat: 140, compose: 66, compact: 122 };
  function positionPanel() {
    const { panelWindow } = host;
    if (!panelWindow || panelWindow.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const marginX = Math.min(20, Math.max(0, (area.width - 1) / 2));
    const marginY = Math.min(20, Math.max(0, (area.height - 1) / 2));
    const width = Math.max(1, Math.min(380, area.width - marginX * 2));
    const availableHeight = Math.max(1, area.height - marginY * 2);
    const height = Math.max(1, Math.min(PANEL_MAX_HEIGHT, availableHeight));
    const bottom = area.y + area.height - marginY;
    const target = { x: Math.round(area.x + area.width - marginX - width),
      y: Math.round(bottom - height), width: Math.round(width), height: Math.round(height) };
    // Keep Chromium's viewport fixed across mode and content changes. The panel
    // sizes itself before paint; only the native drawing/hit region follows it.
    const current = panelWindow.getBounds();
    if (Object.entries(target).some(([key, value]) => Math.abs(current[/** @type {keyof Electron.Rectangle} */ (key)] - value) > 2)) panelWindow.setBounds(target);
    const viewport = panelWindow.getContentBounds();
    const visibleHeight = Math.max(1, Math.min(panelHeight, viewport.height));
    panelWindow.setShape([{ x: 0, y: Math.max(0, viewport.height - visibleHeight), width: viewport.width, height: visibleHeight }]);
    panelWindow.webContents.send('voice:resizing', false);
  }
  function renderHidePanel() {
    const { panelWindow } = host;
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
  function holdPanel() {
    clearTimeout(panelResetTimer);
    panelResetTimer = undefined;
    host.panelWindow?.hide();
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
    // Mode changes only touch renderer layout and the measured native region.
    panelWindow.webContents.send('voice:mode', panelMode);
  }

  return {
    create: async () => {
      if (disposed) return;
      host.panelWindow = new BrowserWindow({
        width: 380, height: PANEL_MAX_HEIGHT, frame: false, skipTaskbar: true,
        resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
        alwaysOnTop: true,
        title: 'Voice Line — rozmowa', show: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        webPreferences: { preload: path.join(root, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: true, backgroundThrottling: false },
      });
      const panelWindow = host.panelWindow;
      panelWindow.setMenu(null);
      const session = panelWindow.webContents.session;
      const languages = ['pl', 'en-US'].filter(language => session.availableSpellCheckerLanguages.includes(language));
      if (languages.length) session.setSpellCheckerLanguages(languages);
      panelWindow.webContents.on('context-menu', (_event, params) => {
        if (!params.isEditable) return;
        const suggestions = params.dictionarySuggestions.map(suggestion => ({ label: suggestion,
          click: () => { if (!panelWindow.isDestroyed()) panelWindow.webContents.replaceMisspelling(suggestion); } }));
        if (params.misspelledWord) suggestions.push({ label: 'Dodaj do słownika',
          click: () => session.addWordToSpellCheckerDictionary(params.misspelledWord) });
        Menu.buildFromTemplate([...suggestions, ...(suggestions.length ? [{ type: /** @type {const} */ ('separator') }] : []),
          { role: 'undo', label: 'Cofnij' }, { role: 'redo', label: 'Ponów' }, { type: 'separator' },
          { role: 'cut', label: 'Wytnij' }, { role: 'copy', label: 'Kopiuj' }, { role: 'paste', label: 'Wklej' },
          { role: 'selectAll', label: 'Zaznacz wszystko' }]).popup({ window: panelWindow });
      });
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
    positionPanel, openPanel: renderOpenPanel, hidePanel: renderHidePanel, holdPanel, samplePointer,
    get mode() { return panelMode; },
    get height() { return panelHeight; }, /** @param {number} value */ set height(value) { panelHeight = value; },
    get heights() { return panelHeights; },
    get resetTimer() { return panelResetTimer; },
    dispose() {
      disposed = true;
      clearTimeout(panelResetTimer);
      removeDisplayListeners();
    },
  };
}
module.exports = { createWindowAdapter };
