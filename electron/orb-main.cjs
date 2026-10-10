const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createOverlayController } = require('./overlay-controller.cjs');
const { createPointerTracker } = require('./overlay-pointer.cjs');
const { readImage } = require('./image-files.cjs');
const { appDataDirectory } = require('./app-data.cjs');
const { conversationMarkdown } = require('./conversation-export.cjs');

const smokeTest = process.argv.includes('--smoke-test');
const dataDirectory = process.argv.includes('--preview')
  ? path.join(__dirname, '..', '.chatgpt-button') : appDataDirectory();
const imageDirectory = path.join(dataDirectory, 'images');
const outputDirectory = smokeTest ? process.env.VOICE_LINE_TEST_OUTPUT_DIR || path.join(dataDirectory, 'captures')
  : path.join(__dirname, '..', '.chatgpt-button');
if (smokeTest) mkdirSync(outputDirectory, { recursive: true });
let savingConversation = false;
// Set these before Chromium initializes. Keep the orb away from other Electron
// profiles, and keep smoke tests away from an already-running desktop instance.
const profileDirectory = smokeTest || process.argv.includes('--preview')
  ? path.join(dataDirectory, 'electron', smokeTest ? `smoke-${process.pid}` : 'preview')
  : path.join(appDataDirectory(), 'electron', 'desktop');
const sessionDirectory = path.join(profileDirectory, 'session');
mkdirSync(sessionDirectory, { recursive: true });
app.setName('Voice Line Orb');
app.setPath('userData', profileDirectory);
app.setPath('sessionData', sessionDirectory);
// Leave transparent space for entry/exit motion and Windows' minimum window size.
const WINDOW_SIZE = 64;
const WINDOW_HEIGHT = 80; // Reserve space below the unchanged orb for the mode label.
const MARGIN = 20;
const PANEL_MAX_HEIGHT = 500;
let orbWindow;
let tray;
let panelWindow;
let engine;
let voice = { state: 'starting', ready: false, question: '', answer: '', message: '',
  mode: process.argv.includes('--smoke-test') || process.argv.includes('--preview') ? 'local' : undefined };
let conversationHistory = [];
const previousConversations = new Map();
const preview = process.argv.includes('--preview');
let testLiveVisibility = false;
let testNativePointer = false;
let pointerPoll;

function sendVoice(update = {}) {
  if (update.purgeHistory) previousConversations.clear();
  const switchedThread = 'threadId' in update && update.threadId !== voice.threadId;
  if (switchedThread && voice.threadId) {
    const exchanges = [...conversationHistory];
    if (voice.answer) exchanges.push({ question: voice.question, answer: voice.answer, ...(voice.images?.length && { images: voice.images }) });
    previousConversations.delete(voice.threadId);
    previousConversations.set(voice.threadId, exchanges);
    if (previousConversations.size > 2) previousConversations.delete(previousConversations.keys().next().value);
  }
  if (Array.isArray(update.exchanges) || update.restored) {
    const exchanges = update.exchanges || previousConversations.get(update.threadId) || [];
    const latest = exchanges.at(-1);
    conversationHistory = exchanges.slice(0, -1);
    update = { ...update, question: latest?.question || '', answer: latest?.answer || '', images: latest?.images || [] };
  } else if (update.reset) {
    conversationHistory = [];
    update = { ...update, question: '', answer: '', images: [] };
  } else if (voice.answer && (update.state === 'listening'
    || (typeof update.question === 'string' && (update.question !== voice.question || update.answer === '')))) {
    conversationHistory.push({ question: voice.question, answer: voice.answer, ...(voice.images?.length && { images: voice.images }) });
  }
  if (update.answer === '' && !('images' in update)) update = { ...update, images: [] };
  voice = { ...voice, message: '', ...update, history: conversationHistory };
  overlay.voice(voice.state);
  state = voice.state === 'listening' ? 'listening' : voice.state === 'speaking' ? 'speaking' : 'idle';
  for (const window of [orbWindow, panelWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('voice:snapshot', voice);
  }
  tray?.setToolTip(`Voice Line: ${voice.state}`);
  sendSettings();
}

async function saveCurrentConversation() {
  if (savingConversation || !voice.ready || !['idle', 'error'].includes(voice.state) || !voice.answer) return 'unavailable';
  const exchanges = structuredClone([...conversationHistory, { question: voice.question, answer: voice.answer, images: voice.images || [] }]);
  savingConversation = true;
  tray?.setContextMenu(menu());
  try {
    const markdown = await conversationMarkdown(exchanges, imageDirectory);
    const choice = await dialog.showSaveDialog(panelWindow, { title: 'Zapisz rozmowę', defaultPath: 'rozmowa.md',
      filters: [{ name: 'Rozmowa Markdown', extensions: ['md'] }] });
    if (choice.canceled || !choice.filePath) return 'cancelled';
    await fs.writeFile(choice.filePath, markdown, 'utf8');
    await dialog.showMessageBox(panelWindow, { type: 'info', message: 'Zapisano rozmowę.',
      detail: 'Plik zawiera treść i obrazy. Automatyczne czyszczenie historii go nie usunie.', buttons: ['Zamknij'] });
    return 'saved';
  } catch {
    await dialog.showMessageBox(panelWindow, { type: 'error', message: 'Nie udało się zapisać rozmowy.',
      detail: 'Sprawdź dostępność obrazów i wybierz folder, w którym możesz zapisywać pliki. Następnie spróbuj ponownie.', buttons: ['Zamknij'] });
    return 'error';
  } finally { savingConversation = false; tray?.setContextMenu(menu()); }
}

function onEngineMessage(message) {
  if (message?.type === 'voice') sendVoice(message);
  else if (message?.type === 'level' && message.source === voice.state && Number.isFinite(message.level)) {
    orbWindow?.webContents.send('orb:level', Math.min(1, Math.max(0, message.level)));
  }
  else if (message?.type === 'ui' && message.action === 'compose') overlay.compose();
}
function startEngine() {
  if (engine || smokeTest || preview) return;
  sendVoice({ state: 'starting', ready: false });
  const child = spawn(process.env.VOICE_LINE_NODE || 'node',
    ['--env-file-if-exists=.env', '--experimental-strip-types', 'src/main.ts', '--desktop', ...(process.argv.includes('--debug') ? ['--debug'] : [])],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  engine = child;
  child.on('message', message => {
    if (engine !== child) return;
    onEngineMessage(message);
  });
  child.on('error', error => {
    console.error(error);
    sendVoice({ state: 'error', ready: false, message: 'Nie można uruchomić aplikacji głosowej. Sprawdź instalację Node.js i spróbuj ponownie.' });
  });
  child.on('exit', () => {
    if (engine !== child) return;
    engine = undefined;
    if (!exitStarted) sendVoice({ state: 'error', ready: false, message: 'Usługi głosowe zostały zatrzymane. Sprawdź ustawienia .env i szczegóły w terminalu, potem uruchom je ponownie.' });
  });
}

const overlay = createOverlayController({
  onChange(value, { focus }) {
    if (process.argv.includes('--debug')) console.log('[overlay]', { ...value, focus });
    if (panelWindow && !panelWindow.isDestroyed()) {
      if (value.mode === 'hidden') {
        if (panelWindow.isVisible()) renderHidePanel();
      } else if (value.mode !== panelMode || !panelWindow.isVisible() || focus) renderOpenPanel(value.mode, focus);
      panelWindow.webContents.send('voice:pinned', value.pinned);
    }
    updateVisibility();
  },
});
function openPanel(focus = true) { overlay.open(Boolean(focus)); }
function hidePanel() { overlay.dismiss(); }
const trackPointer = createPointerTracker((surface, entered) => overlay.hover(surface, entered));
function samplePointer(cursor = screen.getCursorScreenPoint()) {
  trackPointer(cursor, {
    orb: orbWindow.isVisible() ? orbWindow.getBounds() : null,
    panel: panelWindow.isVisible() ? panelWindow.getBounds() : null,
  });
}

let panelResetTimer;
let panelMode = 'peek';
let panelHeight = 80;
const panelHeights = { peek: 80, chat: 140, compose: 66 };
let panelResizeTimer;
function positionPanel(animate = false) {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  const orb = orbWindow.getBounds();
  const area = screen.getDisplayMatching(orb).workArea;
  const width = Math.min(380, area.width);
  const height = Math.min(panelHeight, PANEL_MAX_HEIGHT, Math.max(1, orb.y - area.y - 8));
  const target = {
    x: Math.max(area.x, Math.min(orb.x + orb.width - width, area.x + area.width - width)),
    y: Math.max(area.y, orb.y - height - 8), width, height,
  };
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
    const currentHeight = Math.round(initial.height + (height - initial.height) * eased);
    panelWindow.setBounds({ ...target, y: orb.y - currentHeight - 8, height: currentHeight });
    if (progress === 1) { clearInterval(panelResizeTimer); done(); }
  }, 16);
}
function renderHidePanel() {
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
function renderOpenPanel(mode, focus) {
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
function trusted(event) {
  return [orbWindow, panelWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
}
ipcMain.on('voice:open', event => {
  if (!trusted(event)) return;
  if (process.argv.includes('--debug')) console.log('[overlay] open request');
  if (event.sender === orbWindow.webContents) overlay.toggle();
  else openPanel();
});
ipcMain.on('voice:resize', (event, size) => {
  if (!panelWindow || event.sender !== panelWindow.webContents || exitStarted
    || !size || !Number.isFinite(size.height) || size.height < 0
    || !['peek', 'chat', 'compose'].includes(size.mode) || size.mode !== panelMode) return;
  const measuredHeight = Math.max(64, Math.min(PANEL_MAX_HEIGHT, Math.ceil(size.height) + 2));
  // Keep the hovered surface stable when a new recording clears the transcript.
  panelHeight = panelWindow.isVisible() && ['listening', 'transcribing', 'thinking'].includes(voice.state)
    ? Math.max(panelHeight, measuredHeight) : measuredHeight;
  panelHeights[size.mode] = panelHeight;
  if (panelResetTimer && !panelWindow.isVisible()) return;
  positionPanel(panelWindow.isVisible() && !size.reducedMotion);
});
ipcMain.handle('voice:copy-code', (event, text) => {
  if (!panelWindow || panelWindow.isDestroyed() || event.sender !== panelWindow.webContents
    || exitStarted || typeof text !== 'string') return false;
  try { clipboard.writeText(text); return true; }
  catch { return false; }
});
ipcMain.handle('voice:text', (event, text) => {
  if (!trusted(event) || exitStarted || typeof text !== 'string' || !text.trim() || text.length > 12000
    || !voice.ready || !engine?.connected || !['idle', 'error'].includes(voice.state)) return false;
  sendVoice({ state: 'thinking', question: text.trim(), answer: '' });
  engine.send({ command: 'text', text: text.trim() });
  return true;
});
ipcMain.handle('voice:image-preview', async (event, id) => {
  if (!panelWindow || event.sender !== panelWindow.webContents || exitStarted) return null;
  try { return `data:image/png;base64,${(await readImage(imageDirectory, id)).toString('base64')}`; }
  catch { return null; }
});
ipcMain.handle('voice:image-save', async (event, id) => {
  if (!panelWindow || event.sender !== panelWindow.webContents || exitStarted) return 'error';
  try {
    const bytes = await readImage(imageDirectory, id);
    const choice = await dialog.showSaveDialog(panelWindow, { title: 'Zapisz obraz', defaultPath: 'obraz',
      filters: [{ name: 'Obraz PNG', extensions: ['png'] }] });
    if (choice.canceled || !choice.filePath) return 'cancelled';
    await fs.writeFile(choice.filePath, bytes);
    return 'saved';
  } catch { return 'error'; }
});
ipcMain.on('voice:hover', (event, entered) => {
  if (!trusted(event) || exitStarted || typeof entered !== 'boolean') return;
  // In production use one native cursor sample for both surfaces. Renderer
  // pointerleave can be caused by window resizing, not actual cursor movement.
  if (!smokeTest || testNativePointer) return;
  overlay.hover(event.sender === orbWindow.webContents ? 'orb' : 'panel', entered);
});
ipcMain.on('voice:command', (event, command) => {
  if (!trusted(event) || exitStarted) return;
  if (command === 'pin' && event.sender === panelWindow?.webContents) { overlay.togglePin(); return; }
  if (command === 'previous') {
    if (event.sender !== panelWindow?.webContents || !voice.ready || !voice.canRestorePrevious
      || !['idle', 'error'].includes(voice.state) || !engine?.connected) return;
    sendVoice({ state: 'thinking' });
    engine.send({ command });
    overlay.open();
    return;
  }
  if (command === 'hide') { hidePanel(); return; }
  if (command === 'retry' && !voice.ready) {
    if (engine) { const previous = engine; engine = undefined; previous.send({ command: 'shutdown' }); previous.once('exit', startEngine); }
    else startEngine();
    return;
  }
  if (['record', 'release', 'cancel', 'reset'].includes(command) && engine?.connected) engine.send({ command });
});
let state = 'idle';
let paused = false;
let exitStarted = false;
let exitFinished = false;
let exitAcknowledged = false;
let exitTimer;
let hideTimer;

function updateVisibility(force = false) {
  if (!orbWindow || orbWindow.isDestroyed() || exitStarted || (!force && ((smokeTest && !testLiveVisibility) || preview))) return;
  clearTimeout(hideTimer);
  if (overlay.snapshot().orbVisible) {
    // Re-showing an already visible native overlay can disturb popup activation
    // on Windows. Voice snapshots should update contents, not window activation.
    if (!orbWindow.isVisible()) orbWindow.showInactive();
    orbWindow.webContents.send('orb:presence', 'visible');
  } else {
    orbWindow.webContents.send('orb:presence', 'hidden');
    hideTimer = setTimeout(() => {
      if (!orbWindow.isDestroyed() && !overlay.snapshot().orbVisible) orbWindow.hide();
    }, 260);
  }
}

function finishExit() {
  if (!exitStarted || exitFinished) return;
  exitFinished = true;
  clearTimeout(exitTimer);
  app.quit();
}

ipcMain.on('orb:ready', event => {
  if (panelWindow && event.sender === panelWindow.webContents) {
    panelWindow.webContents.send('voice:pinned', overlay.snapshot().pinned);
    sendVoice(); return;
  }
  if (!orbWindow || event.sender !== orbWindow.webContents) return;
  if (smokeTest || preview) {
    orbWindow.showInactive();
    orbWindow.webContents.send('orb:presence', 'visible');
  }
  sendVoice();
});
ipcMain.on('orb:exit-complete', event => {
  if (orbWindow && event.sender === orbWindow.webContents && exitStarted) {
    exitAcknowledged = true;
    finishExit();
  }
});
app.on('will-quit', () => {
  if (!smokeTest) return;
  if (!exitAcknowledged) {
    console.error('Exit animation did not acknowledge completion');
    app.exit(1);
  } else console.log('Exit animation: passed');
});
app.on('before-quit', event => {
  if (exitFinished || !orbWindow || orbWindow.isDestroyed()) return;
  event.preventDefault();
  if (exitStarted) return;
  exitStarted = true;
  overlay.dispose();
  clearTimeout(panelResetTimer);
  clearInterval(panelResizeTimer);
  clearTimeout(hideTimer);
  clearInterval(pointerPoll);
  if (engine?.connected) engine.send({ command: 'shutdown' });
  panelWindow?.hide();
  exitTimer = setTimeout(finishExit, smokeTest ? 2500 : 700);
  orbWindow.webContents.send('orb:presence', 'leaving');
});

function position() {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  return { x: x + width - WINDOW_SIZE - MARGIN, y: y + height - WINDOW_SIZE - MARGIN };
}

function sendSettings() {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.webContents.send('orb:settings', { state, paused });
  }
  tray?.setContextMenu(menu());
  updateVisibility();
}

function menu() {
  return Menu.buildFromTemplate([
    { label: 'Otwórz rozmowę', click: openPanel },
    ...(!preview ? [
      { label: 'Przerwij', enabled: voice.ready, click: () => engine?.connected && engine.send({ command: 'cancel' }) },
      { label: 'Nowa rozmowa', enabled: voice.ready, click: () => engine?.connected && engine.send({ command: 'reset' }) },
      { label: 'Zapisz rozmowę…', enabled: voice.ready && Boolean(voice.answer) && ['idle', 'error'].includes(voice.state) && !savingConversation,
        click: () => { void saveCurrentConversation(); } },
    ] : [['idle', 'Spoczynek'], ['listening', 'Słuchanie (test)'], ['speaking', 'Mówienie (test)']].map(([value, label]) => ({
      label, type: 'radio', checked: state === value,
      click: () => { state = value; sendSettings(); },
    }))),
    { type: 'separator' },
    { label: 'Wstrzymaj animację', type: 'checkbox', checked: paused,
      click: item => { paused = item.checked; sendSettings(); } },
    { label: 'Zakończ', click: () => app.quit() },
  ]);
}

function trayImage() {
  // Small native bitmap of the orb; no external assets or network requests.
  const bitmap = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      if (Math.hypot(x - 7.5, y - 7.5) > 7.3) continue;
      const color = y < 6 ? [232, 97, 51] : y < 9 ? [255, 250, 247] : [250, 194, 179];
      bitmap.set([...color, 255], (y * 16 + x) * 4); // Native BGRA.
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 });
}

async function verify() {
  await orbWindow.webContents.executeJavaScript("customElements.whenDefined('voice-orb').then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
  const inspect = () => orbWindow.webContents.executeJavaScript(`(() => {
    const orb = document.querySelector('voice-orb');
    const canvas = orb.shadowRoot.querySelector('canvas');
    return { size: orb.clientWidth, buffer: canvas.width, ready: canvas.parentElement.classList.contains('rendered'),
      state: orb.state, paused: orb.hasAttribute('paused'), background: getComputedStyle(document.body).backgroundColor,
      presence: document.body.dataset.presence,
      animation: getComputedStyle(canvas.parentElement).animationName };
  })()`);
  const initial = await inspect();
  assert.equal(initial.size, 45);
  assert.equal(initial.buffer, 9);
  assert.equal(initial.ready, true, 'WebGL should compile and render');
  assert.equal(initial.background, 'rgba(0, 0, 0, 0)');
  assert.equal(initial.presence, 'visible');
  await orbWindow.webContents.executeJavaScript(`new Promise(resolve => {
    const orb = document.querySelector('voice-orb');
    if (Number(getComputedStyle(orb).opacity) >= .999) { resolve(); return; }
    const done = event => {
      if (event.target === orb && event.propertyName === 'opacity') {
        orb.removeEventListener('transitionend', done); resolve();
      }
    };
    orb.addEventListener('transitionend', done);
    setTimeout(resolve, 500);
  })`);
  assert.equal(await orbWindow.webContents.executeJavaScript("Number(getComputedStyle(document.querySelector('voice-orb')).opacity)"), 1);
  assert.equal(app.getPath('userData'), profileDirectory);
  assert.equal(app.getPath('sessionData'), sessionDirectory);
  assert.equal(orbWindow.webContents.session.getStoragePath(), sessionDirectory);
  assert.equal(orbWindow.isAlwaysOnTop(), true);
  assert.deepEqual(orbWindow.getBounds(), { ...position(), width: WINDOW_SIZE, height: WINDOW_HEIGHT });
  for (const [mode, label] of [['realtime', 'API'], ['local', 'LOCAL']]) {
    sendVoice({ mode });
    await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    const indicator = await orbWindow.webContents.executeJavaScript(`(() => {
      const label = document.querySelector('#voice-mode');
      const bounds = label.getBoundingClientRect();
      return { text: label.textContent, hidden: label.hidden, bottom: bounds.bottom,
        buttonTop: document.querySelector('button').getBoundingClientRect().top };
    })()`);
    assert.equal(indicator.text, label);
    assert.equal(indicator.hidden, false);
    assert.ok(indicator.bottom <= WINDOW_HEIGHT);
    assert.equal(indicator.buttonTop, 5);
  }
  assert.equal(panelWindow.isVisible(), false, 'Conversation starts hidden');
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter'))");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(panelWindow.isVisible(), true, 'Hover opens the popup');
  assert.equal(panelWindow.isFocused(), false, 'Hover does not steal focus');
  const popupBounds = panelWindow.getBounds();
  // Windows rounds native window bounds at fractional display scaling.
  assert.ok(Math.abs(popupBounds.y + popupBounds.height + 8 - orbWindow.getBounds().y) <= 2,
    JSON.stringify({ popupBounds, orb: orbWindow.getBounds() }));
  assert.ok(Math.abs(popupBounds.x + popupBounds.width - orbWindow.getBounds().x - WINDOW_SIZE) <= 2,
    JSON.stringify({ popupBounds, orb: orbWindow.getBounds() }));
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
  await panelWindow.webContents.executeJavaScript("document.documentElement.dispatchEvent(new PointerEvent('pointerenter'))");
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(panelWindow.isVisible(), true, 'Moving into the popup keeps it open');
  await panelWindow.webContents.executeJavaScript("document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), false, 'Leaving both surfaces closes the popup');
  openPanel(false);
  await panelWindow.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(panelWindow.isVisible(), false, 'Escape closes the popup');
  state = 'listening'; sendSettings();
  console.log('Popup hover checks: passed');
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  const listening = await inspect();
  assert.equal(listening.state, 'listening');
  const reducedMotion = await orbWindow.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(listening.animation, 'none', 'Desktop uses the measured audio envelope');
  state = 'speaking'; paused = true; sendSettings();
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  const changed = await inspect();
  assert.equal(changed.state, 'speaking');
  assert.equal(changed.paused, true);
  assert.equal(changed.animation, 'none');
  // Exercise real snapshots in both sandboxed renderers without opening a microphone.
  sendVoice({ state: 'idle', ready: true }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Orb stays hidden while idle');
  sendVoice({ state: 'listening', question: '', answer: '' }); updateVisibility(true);
  assert.equal(orbWindow.isVisible(), true, 'Recording reveals the orb');
  const audioScale = () => orbWindow.webContents.executeJavaScript("Number(getComputedStyle(document.querySelector('voice-orb').shadowRoot.querySelector('.sphere')).scale)");
  paused = false; sendSettings();
  onEngineMessage({ type: 'level', source: 'listening', level: 1 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(reducedMotion ? await audioScale() === 1 : await audioScale() > 1.15, 'Loud speech grows the orb');
  onEngineMessage({ type: 'level', source: 'listening', level: 0 });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(await audioScale() < 1.01, 'Silence returns the orb to its base size');
  sendVoice({ state: 'speaking' });
  onEngineMessage({ type: 'level', source: 'speaking', level: .8 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(reducedMotion ? await audioScale() === 1 : await audioScale() > 1.1, 'Playback also drives scale');
  sendVoice({ state: 'idle' });
  onEngineMessage({ type: 'level', source: 'speaking', level: 1 });
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.ok(await audioScale() < 1.01, 'Late playback levels cannot animate an idle orb');
  console.log('Audio reactive scale checks: passed');
  sendVoice({ state: 'thinking', question: 'Test <script>unsafe</script>' }); updateVisibility(true);
  assert.equal(orbWindow.isVisible(), true, 'Processing keeps the orb visible');
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const ring = () => orbWindow.webContents.executeJavaScript(`(() => {
    const style = getComputedStyle(document.querySelector('button'), '::after');
    return { content: style.content, animation: style.animationName, paused: style.animationPlayState,
      direction: style.animationDirection, duration: style.animationDuration,
      border: style.borderTopStyle, visibility: style.visibility };
  })()`);
  for (const waitingState of ['transcribing', 'thinking', 'preparing-speech']) {
    sendVoice({ state: waitingState });
    const waitingRing = await ring();
    assert.equal(waitingRing.animation, reducedMotion ? 'none' : 'wait-spin');
    assert.equal(waitingRing.border, 'solid');
    assert.equal(waitingRing.visibility, 'visible');
  }
  paused = true; sendSettings();
  assert.equal((await ring()).paused, 'paused');
  paused = false; sendSettings();
  orbWindow.webContents.debugger.attach('1.3');
  try {
    await orbWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    assert.equal((await ring()).animation, 'wait-spin');
    for (const waitingState of ['transcribing', 'thinking', 'preparing-speech']) {
      sendVoice({ state: waitingState });
      const waitingRing = await ring();
      assert.equal(waitingRing.direction, waitingState === 'transcribing' ? 'normal' : 'reverse');
      assert.equal(waitingRing.duration, waitingState === 'transcribing' ? '1s' : '0.5s');
    }
    const rotation = () => orbWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('button'), '::after').transform");
    const firstRotation = await rotation();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.notEqual(await rotation(), firstRotation, 'Waiting ring actually rotates');
    await orbWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    assert.equal((await ring()).animation, 'none', 'Reduced motion stops the waiting ring');
  } finally {
    await orbWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    orbWindow.webContents.debugger.detach();
  }
  const waitingOutput = path.join(outputDirectory, 'electron-orb-waiting.png');
  console.log('Voice state checks: passed');
  await fs.writeFile(waitingOutput, (await orbWindow.webContents.capturePage()).toPNG());
  sendVoice({ state: 'speaking', answer: 'Odpowiedź testowa.' }); updateVisibility(true);
  assert.equal((await ring()).content, 'none', 'Playback removes the waiting ring');
  const panel = await panelWindow.webContents.executeJavaScript(`(() => ({
    status: document.querySelector('#status').textContent,
    question: document.querySelector('#question').textContent,
    unsafe: document.querySelector('#question script') !== null,
    answer: document.querySelector('#answer').textContent,
    cancelAbsent: document.querySelector('#cancel') === null,
  }))()`);
  assert.equal(panel.status, 'Odczytuję odpowiedź…');
  assert.equal(panel.unsafe, false);
  assert.equal(panel.answer, 'Odpowiedź testowa.');
  assert.equal(panel.cancelAbsent, true);
  console.log('Conversation snapshot checks: passed');
  const panelOutput = path.join(outputDirectory, 'electron-conversation.png');
  openPanel(false);
  await fs.writeFile(panelOutput, (await panelWindow.webContents.capturePage()).toPNG());
  const codeSample = 'if (ready) {\n  console.log("<script>unsafe</script>");\n}\n' + '// ' + 'long-line-'.repeat(80) + '\n';
  const codeReply = 'Użyj `node`.\n```js\n' + codeSample + '```\nGotowe.';
  sendVoice({ answer: codeReply });
  await new Promise(resolve => setTimeout(resolve, 100));
  const codePanel = await panelWindow.webContents.executeJavaScript(`(() => {
    const answer = document.querySelector('#answer');
    const pre = answer.querySelector('pre');
    return {
      code: pre.querySelector('code').textContent,
      inline: answer.querySelector('p code').textContent,
      unsafe: answer.querySelector('script') !== null,
      scrolls: pre.scrollWidth > pre.clientWidth,
      fits: document.documentElement.scrollWidth <= innerWidth,
      keyboard: pre.tabIndex,
      copyIcon: answer.querySelector('.code-copy svg') !== null,
      copyLabel: answer.querySelector('.code-copy').getAttribute('aria-label'),
      copyText: answer.querySelector('.code-copy').textContent,
    };
  })()`);
  assert.equal(codePanel.code, codeSample);
  assert.equal(codePanel.inline, 'node');
  assert.equal(codePanel.unsafe, false);
  assert.equal(codePanel.scrolls, true, 'Long code lines scroll horizontally');
  assert.equal(codePanel.fits, true, 'Code does not widen the popup');
  assert.equal(codePanel.keyboard, 0, 'Code scroller supports keyboard focus');
  assert.equal(codePanel.copyIcon, true, 'Copy uses an icon');
  assert.equal(codePanel.copyLabel, 'Kopiuj kod');
  assert.equal(codePanel.copyText, '', 'Copy has no visible text label');
  // Mock only the native sink: exercise the real renderer/preload/IPC chain
  // without reading or changing the user's clipboard.
  const originalClipboardWrite = clipboard.writeText;
  let copiedText;
  clipboard.writeText = text => { copiedText = text; };
  const clickCopy = () => panelWindow.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('#answer .code-copy');
    button.focus(); button.click();
    for (let attempt = 0; attempt < 50 && button.disabled; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return {
      feedback: document.querySelector('#answer [role=status]').textContent,
      enabled: !button.disabled,
      copied: button.dataset.copied === 'true',
      feedbackHidden: document.querySelector('#answer [role=status]').className === 'sr-only',
    };
  })()`);
  try {
    panelWindow.blur();
    const copied = await clickCopy();
    assert.equal(copiedText, codeSample, 'Copy passes exact code through preload and IPC without popup focus');
    assert.equal(copied.feedback, 'Skopiowano');
    assert.equal(copied.copied, true, 'Copy icon becomes a checkmark');
    assert.equal(copied.feedbackHidden, true, 'Success feedback does not add space below code');
    assert.equal(copied.enabled, true);
    clipboard.writeText = () => { throw new Error('Unavailable'); };
    const failed = await clickCopy();
    assert.match(failed.feedback, /Ctrl\+C/);
    assert.equal(failed.copied, false);
    assert.equal(failed.enabled, true);
  } finally { clipboard.writeText = originalClipboardWrite; }
  await fs.writeFile(path.join(outputDirectory, 'electron-conversation-code.png'), (await panelWindow.webContents.capturePage()).toPNG());
  sendVoice({ answer: 'Odpowiedź testowa.' });
  console.log('Code answer checks: passed');
  const imageBytes = nativeImage.createFromBitmap(Buffer.alloc(256 * 256 * 4, 255), { width: 256, height: 256 }).toPNG();
  const imageId = require('node:crypto').createHash('sha256').update(imageBytes).digest('hex');
  await fs.mkdir(imageDirectory, { recursive: true });
  await fs.writeFile(path.join(imageDirectory, `${imageId}.png`), imageBytes);
  sendVoice({ state: 'thinking', question: 'Wygeneruj obraz kwadratu.', answer: '', generatingImage: true });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').textContent"), 'Generuję obraz…');
  sendVoice({ state: 'idle', generatingImage: false, answer: 'Gotowe.', images: [{ id: imageId, alt: 'Testowy kwadrat' }] });
  const imagePanel = await panelWindow.webContents.executeJavaScript(`(async () => {
    const image = document.querySelector('#images img');
    for (let i = 0; i < 100 && !image.naturalWidth; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const button = document.querySelector('#images button');
    const imageRect = image.getBoundingClientRect(), buttonRect = button.getBoundingClientRect();
    return { width: image.naturalWidth, alt: image.alt, fits: document.documentElement.scrollWidth <= innerWidth,
      icon: button.querySelector('svg') !== null, label: button.getAttribute('aria-label'), text: button.textContent,
      background: getComputedStyle(button).backgroundColor,
      corner: Math.abs(imageRect.right - buttonRect.right - 4) < 1 && Math.abs(buttonRect.top - imageRect.top - 4) < 1,
      size: buttonRect.width };
  })()`);
  assert.equal(imagePanel.width, 256); assert.equal(imagePanel.alt, 'Testowy kwadrat'); assert.ok(imagePanel.fits);
  assert.ok(imagePanel.icon && imagePanel.corner); assert.equal(imagePanel.size, 24); assert.equal(imagePanel.text, '');
  assert.match(imagePanel.label, /Zapisz obraz/); assert.match(imagePanel.background, /0\.75/);
  assert.equal(await panelWindow.webContents.executeJavaScript("window.orbDesktop.imagePreview('../../.env')"), null);
  const originalSaveDialog = dialog.showSaveDialog;
  const savedImage = path.join(profileDirectory, 'image-save-test.png');
  const clickSaveImage = () => panelWindow.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('#images button'); button.focus(); button.click();
    for (let i = 0; i < 100 && button.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
    return document.querySelector('#images [role=status]').textContent;
  })()`);
  try {
    dialog.showSaveDialog = async () => ({ canceled: true });
    assert.equal(await clickSaveImage(), '');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedImage });
    assert.equal(await clickSaveImage(), 'Zapisano obraz.');
    assert.deepEqual(await fs.readFile(savedImage), imageBytes);
    const savedConversation = path.join(profileDirectory, 'conversation-save-test.md');
    const originalMessageBox = dialog.showMessageBox;
    const messages = [];
    dialog.showMessageBox = async (_window, options) => { messages.push(options.message); return { response: 0 }; };
    try {
      dialog.showSaveDialog = async () => ({ canceled: true });
      assert.equal(await saveCurrentConversation(), 'cancelled');
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedConversation });
      assert.equal(await saveCurrentConversation(), 'saved');
      assert.match(await fs.readFile(savedConversation, 'utf8'), /data:image\/png;base64,/);
      assert.equal(messages.at(-1), 'Zapisano rozmowę.');
      sendVoice({ state: 'thinking' });
      assert.equal(await saveCurrentConversation(), 'unavailable');
      assert.equal(menu().items.find(item => item.label === 'Zapisz rozmowę…').enabled, false);
      sendVoice({ state: 'idle' });
      dialog.showSaveDialog = async () => { throw new Error('Simulated save failure'); };
      assert.equal(await saveCurrentConversation(), 'error');
      assert.equal(messages.at(-1), 'Nie udało się zapisać rozmowy.');
    } finally { dialog.showMessageBox = originalMessageBox; }
    await fs.writeFile(path.join(outputDirectory, 'electron-conversation-image.png'), (await panelWindow.webContents.capturePage()).toPNG());
  } finally { dialog.showSaveDialog = originalSaveDialog; }
  sendVoice({ images: [], answer: 'Odpowiedź testowa.' });
  sendVoice({ images: [{ id: 'f'.repeat(64), alt: 'Brak obrazu' }] });
  const unavailable = await panelWindow.webContents.executeJavaScript(`(async () => {
    const feedback = document.querySelector('#images [role=status]');
    for (let i = 0; i < 100 && !feedback.textContent; i++) await new Promise(resolve => setTimeout(resolve, 20));
    return { message: feedback.textContent, disabled: document.querySelector('#images button').disabled };
  })()`);
  assert.match(unavailable.message, /niedostępny/); assert.ok(unavailable.disabled);
  sendVoice({ images: [] });
  console.log('Image preview and native save checks: passed');
  hidePanel();
  sendVoice({ state: 'idle' }); updateVisibility(true);
  console.log('Conversation capture: passed');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Orb disappears when playback finishes');
  orbWindow.showInactive();
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter'))");
  sendVoice({ state: 'idle' }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), true, 'Hover keeps the orb visible after playback');
  await panelWindow.webContents.executeJavaScript("document.documentElement.dispatchEvent(new PointerEvent('pointerenter'))");
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
  updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), true, 'Hovering the popup also keeps the orb visible');
  await panelWindow.webContents.executeJavaScript("document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))");
  updateVisibility(true);
  assert.equal(orbWindow.isVisible(), true, 'Crossing grace period preserves orb visibility');
  await new Promise(resolve => setTimeout(resolve, 1100));
  updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Leaving both surfaces lets the idle orb hide');
  for (const activeState of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']) {
    sendVoice({ state: activeState }); updateVisibility(true);
    await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter')); document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
    await new Promise(resolve => setTimeout(resolve, 1400));
    updateVisibility(true);
    assert.equal(panelWindow.isVisible(), false, `${activeState}: departure closes popup`);
    assert.equal(orbWindow.isVisible(), true, `${activeState}: departure cannot hide active orb`);
  }
  sendVoice({ state: 'idle' }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Completion hides orb after departure timer has expired');
  console.log('Active voice departure checks: passed');
  sendVoice({ state: 'error', ready: false, message: 'Sprawdź mikrofon.' });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#retry').hidden"), false);
  sendVoice({ state: 'idle', ready: true, reset: true });
  assert.equal(voice.history.length, 0, 'New conversation clears display history');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#empty').hidden"), false);
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  openPanel(false);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), true);
  const peekHeight = panelWindow.getBounds().height;
  const peekContent = await panelWindow.webContents.executeJavaScript('document.body.getBoundingClientRect().height');
  assert.ok(Math.abs(peekHeight - peekContent) <= 4, `Hover popup fits its content: ${peekHeight}, content ${peekContent}, requested ${panelHeight}`);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('h2') === null"), true);
  testLiveVisibility = true;
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter'))");
  orbWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 32, y: 32 });
  orbWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 32, y: 32, button: 'left', clickCount: 1 });
  orbWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 32, y: 32, button: 'left', clickCount: 1 });
  sendVoice({ state: 'speaking' });
  assert.equal(await orbWindow.webContents.executeJavaScript("document.querySelector('button').hasAttribute('title')"), false, 'Orb has no native tooltip');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.activeElement.id"), 'message');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.documentElement.scrollHeight <= innerHeight || document.documentElement.dataset.resizing === 'true'"), true, 'Expansion does not expose a scrollbar');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(panelWindow.getBounds().height > peekHeight, 'Click expands the native popup');
  assert.equal(await panelWindow.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true, 'Short conversation and composer fit without scrolling');
  assert.equal(panelWindow.isVisible(), true, 'Live voice snapshots do not dismiss the expanded popup');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value = 'Zachowany szkic'");
  orbWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 32, y: 32, button: 'left', clickCount: 1 });
  orbWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 32, y: 32, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'peek', 'Second orb click collapses the conversation');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden && document.querySelector('#history').hidden"), true);
  assert.ok(Math.abs(panelWindow.getBounds().height - peekHeight) <= 4, 'Second click restores the compact native height during playback');
  assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true, 'Collapse keeps both hovered surfaces visible');
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').click()");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat', 'Keyboard activation expands again');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Zachowany szkic', 'Toggle preserves the draft');
  testNativePointer = true;
  const hoveredPanel = panelWindow.getBounds();
  samplePointer({ x: hoveredPanel.x + 20, y: hoveredPanel.y + hoveredPanel.height - 20 });
  overlay.hover('orb', false);
  for (const nextState of ['listening', 'transcribing', 'thinking', 'speaking', 'idle']) {
    sendVoice({ state: nextState, ...(nextState === 'listening' ? { question: '', answer: '' } : {}) });
    await new Promise(resolve => setTimeout(resolve, 100));
    samplePointer({ x: hoveredPanel.x + 20, y: hoveredPanel.y + hoveredPanel.height - 20 });
  }
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(orbWindow.isVisible(), true, 'Native pointer keeps orb visible across a second question');
  assert.equal(panelWindow.isVisible(), true, 'Second voice cycle preserves popup');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  testNativePointer = false;
  overlay.hover('panel', false);
  openPanel();
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  testLiveVisibility = false;
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
  sendVoice({ state: 'idle' });
  const commands = [];
  console.log('Conversation mode checks: passed');
  engine = { connected: true, send: message => commands.push(message) };
  previousConversations.clear();
  const savedExchanges = [{ question: 'Zapisane pytanie', answer: 'Zapisana odpowiedź' },
    { question: 'Kolejne zapisane pytanie', answer: 'Kolejna zapisana odpowiedź' }];
  onEngineMessage({ type: 'voice', state: 'idle', ready: true, threadId: 'saved-thread',
    canRestorePrevious: false, exchanges: savedExchanges });
  assert.equal(voice.question, savedExchanges[1].question, 'Startup displays the resumed thread latest question');
  assert.equal(voice.answer, savedExchanges[1].answer);
  assert.deepEqual(voice.history, savedExchanges.slice(0, -1));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#answer').textContent"), savedExchanges[1].answer);
  previousConversations.clear();
  onEngineMessage({ type: 'voice', state: 'idle', ready: true, threadId: 'expired-saved-thread',
    restored: true, canRestorePrevious: false, exchanges: savedExchanges });
  assert.equal(voice.answer, savedExchanges[1].answer, 'Undo loads messages even when the Electron archive is empty after restart');
  assert.deepEqual(voice.history, savedExchanges.slice(0, -1));
  console.log('Restart conversation hydration checks: passed');
  sendVoice({ state: 'idle', ready: true, reset: true, threadId: 'undo-first', canRestorePrevious: false });
  sendVoice({ question: 'Pierwsze pytanie', answer: 'Pierwsza odpowiedź' });
  sendVoice({ state: 'thinking', question: 'Drugie pytanie', answer: '' });
  sendVoice({ state: 'idle', answer: 'Druga odpowiedź' });
  sendVoice({ reset: true, threadId: null, canRestorePrevious: true });
  await panelWindow.webContents.executeJavaScript("document.querySelector('#previous').click(); document.querySelector('#previous').click()");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(commands, [{ command: 'previous' }], 'Undo sends one command and blocks duplicate clicks while pending');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#previous').disabled"), true);
  onEngineMessage({ type: 'voice', state: 'idle', threadId: 'undo-first', restored: true, canRestorePrevious: false });
  assert.equal(voice.question, 'Drugie pytanie');
  assert.equal(voice.answer, 'Druga odpowiedź');
  assert.deepEqual(voice.history, [{ question: 'Pierwsze pytanie', answer: 'Pierwsza odpowiedź' }]);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#previous').disabled"), true, 'No previous conversation disables undo');
  sendVoice({ reset: true, threadId: null, canRestorePrevious: true });
  sendVoice({ state: 'idle', threadId: 'undo-second', question: 'Nowy temat', answer: 'Nowa odpowiedź' });
  await panelWindow.webContents.executeJavaScript("document.querySelector('#previous').focus()");
  assert.equal(await panelWindow.webContents.executeJavaScript('document.activeElement.id'), 'previous');
  panelWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  panelWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(commands.at(-1).command, 'previous', 'Undo supports keyboard activation');
  onEngineMessage({ type: 'voice', state: 'idle', threadId: 'undo-first', restored: true, canRestorePrevious: true });
  assert.equal(voice.answer, 'Druga odpowiedź');
  onEngineMessage({ type: 'voice', state: 'idle', threadId: 'undo-second', restored: true, canRestorePrevious: true });
  assert.equal(voice.answer, 'Nowa odpowiedź', 'Returning also preserves the conversation being left');
  const undoGeometry = await panelWindow.webContents.executeJavaScript(`(() => {
    const undo = document.querySelector('#previous').getBoundingClientRect();
    const pin = document.querySelector('#pin').getBoundingClientRect();
    return { width: undo.width, height: undo.height, adjacent: undo.right <= pin.left, top: undo.top === pin.top };
  })()`);
  assert.deepEqual(undoGeometry, { width: 24, height: 24, adjacent: true, top: true });
  sendVoice({ reset: true, threadId: null, canRestorePrevious: false });
  commands.length = 0;
  console.log('Previous conversation undo checks: passed');
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  testLiveVisibility = true;
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(orbWindow.isVisible(), true, 'Copilot tap shows the idle orb');
  assert.equal(panelWindow.isVisible(), true, 'Copilot tap opens the popup');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compose');
  assert.equal(await panelWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('main')).display"), 'none', 'Input-only mode hides the old conversation');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.activeElement.id"), 'message');
  assert.ok(panelWindow.getBounds().height <= 72, 'Input-only popup stays compact; pin occupies no layout space');
  assert.equal(await panelWindow.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true);
  await fs.writeFile(path.join(outputDirectory, 'electron-conversation-compose.png'), (await panelWindow.webContents.capturePage()).toPNG());
  testLiveVisibility = false;
  console.log('Copilot input-only mode checks: passed');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').click()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(overlay.snapshot().pinned, true);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').getAttribute('aria-pressed')"), 'true');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').getAttribute('aria-label')"), 'Odepnij popup');
  assert.equal(await panelWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('#pin')).position"), 'fixed');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin svg') !== null"), true);
  overlay.hover('orb', false);
  overlay.hover('panel', true);
  overlay.hover('panel', false);
  panelWindow.blur();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), true, 'Pin preserves popup after blur and departure');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').click()");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), false, 'Unpin restores departure hiding');
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  console.log('Popup pin checks: passed');
  const fill = text => panelWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#message');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input'));
  })()`);
  await fill('   ');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').requestSubmit()");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(commands.length, 0, 'Blank messages are not sent');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#send') === null"), true);
  await fill('Kontynuuj rozmowę');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))");
  assert.equal(commands.length, 0, 'IME confirmation does not submit');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); document.querySelector('#composer').requestSubmit()");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(commands, [{ command: 'text', text: 'Kontynuuj rozmowę' }]);
  assert.equal(voice.question, 'Kontynuuj rozmowę');
  assert.equal(voice.answer, '', 'New question clears the previous reply');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat', 'Submitting from input-only mode reveals the conversation');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').hidden"), true, 'Answer preparation has no status text');
  assert.equal(voice.history.at(-1).question, 'Jak zaplanować dzień?', 'Previous exchange is retained');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  await panelWindow.webContents.executeJavaScript("window.orbDesktop.command('cancel')");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(commands.at(-1).command, 'cancel');
  engine = undefined;
  sendVoice({ state: 'idle', ready: true });
  await fill('Zachowaj tę wiadomość');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').requestSubmit()");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Zachowaj tę wiadomość', 'Rejected messages preserve the draft');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#error').hidden"), false);
  panelWindow.setSize(340, 420);
  sendVoice({ answer: 'Długa odpowiedź. '.repeat(300) });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight > innerHeight"), true);
  await panelWindow.webContents.executeJavaScript("scrollTo(0, document.documentElement.scrollHeight)");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').getBoundingClientRect().bottom <= innerHeight + 1"), true);
  assert.ok(panelWindow.getBounds().height <= PANEL_MAX_HEIGHT, 'Long answers cap the popup at 500 px');
  console.log('Text composer checks: passed');
  const chatOutput = path.join(outputDirectory, 'electron-conversation-chat.png');
  sendVoice({ state: 'idle', ready: true, question: 'Jak mogę lepiej zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania. Zacznij od jednego i zostaw trochę miejsca na przerwy.' });
  positionPanel();
  await panelWindow.webContents.executeJavaScript('scrollTo(0, 0)');
  openPanel();
  await new Promise(resolve => setTimeout(resolve, 350));
  await fs.writeFile(chatOutput, (await panelWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  for (let index = 0; index < 10; index++) {
    sendVoice({ state: 'idle', question: `Pytanie ${index}`, answer: 'Poprzednia odpowiedź. '.repeat(8) });
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(await panelWindow.webContents.executeJavaScript("document.querySelectorAll('#history .exchange').length") >= 10);
  assert.equal(await panelWindow.webContents.executeJavaScript('document.documentElement.scrollHeight > innerHeight'), true, 'Expanded thread can scroll to earlier exchanges');
  await panelWindow.webContents.executeJavaScript('scrollTo(0, 0)');
  sendVoice({ state: 'speaking' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await panelWindow.webContents.executeJavaScript('scrollY'), 0, 'Status updates preserve reading position');
  assert.equal(await panelWindow.webContents.executeJavaScript("Math.abs(document.querySelector('#composer').getBoundingClientRect().bottom - innerHeight) <= 1"), true, 'Composer is flush with the bottom edge');
  hidePanel();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false, 'Hide preserves content until native surface disappears');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), true, 'Composer resets while popup is hidden');
  openPanel();
  await new Promise(resolve => setTimeout(resolve, 50));
  hidePanel();
  openPanel();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false, 'Rapid reopen cancels the delayed reset');
  hidePanel();
  openPanel(false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), true, 'Dismissal restores the minimal hover mode');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#history').hidden"), true, 'Hover hides earlier messages');
  hidePanel();
  orbWindow.showInactive();
  orbWindow.webContents.send('orb:presence', 'visible');
  await new Promise(resolve => setTimeout(resolve, 150));
  const output = path.join(outputDirectory, 'electron-orb.png');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, (await orbWindow.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ result: 'passed', ...initial, profile: profileDirectory,
    cache: sessionDirectory, bounds: orbWindow.getBounds(), screenshot: output }));
}

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openPanel);
  app.whenReady().then(async () => {
    orbWindow = new BrowserWindow({
      ...position(), width: WINDOW_SIZE, height: WINDOW_HEIGHT,
      title: 'Kulka głosowa', frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: true,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false,
      },
    });
    // Keep the overlay above other windows, including full-screen applications.
    orbWindow.setAlwaysOnTop(true, 'screen-saver');
    orbWindow.on('show', () => orbWindow.setAlwaysOnTop(true, 'screen-saver'));
    orbWindow.setMenu(null);
    orbWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    orbWindow.webContents.on('will-navigate', event => event.preventDefault());
    orbWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    orbWindow.webContents.on('context-menu', () => menu().popup({ window: orbWindow }));
    const reposition = () => {
      if (!orbWindow.isDestroyed()) { const { x, y } = position(); orbWindow.setPosition(x, y); }
      positionPanel();
    };
    screen.on('display-metrics-changed', reposition);
    screen.on('display-added', reposition);
    screen.on('display-removed', reposition);
    await orbWindow.loadFile(path.join(__dirname, 'orb.html'));
    panelWindow = new BrowserWindow({
      width: 380, height: 80, frame: false, skipTaskbar: true,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true,
      title: 'Voice Line — rozmowa', show: false, backgroundColor: '#242220',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    panelWindow.setMenu(null);
    panelWindow.setAlwaysOnTop(true, 'screen-saver');
    panelWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panelWindow.webContents.on('will-navigate', event => event.preventDefault());
    panelWindow.on('close', event => { if (!exitStarted) { event.preventDefault(); hidePanel(); } });
    await panelWindow.loadFile(path.join(__dirname, 'conversation.html'));
    if (!smokeTest) {
      pointerPoll = setInterval(() => {
        if (exitStarted || orbWindow.isDestroyed() || panelWindow.isDestroyed()) return;
        samplePointer();
      }, 50);
    }
    if (smokeTest) {
      try { await verify(); app.quit(); }
      catch (error) { console.error(error); app.exit(1); }
    } else {
      tray = new Tray(trayImage());
      tray.setToolTip('Kulka głosowa');
      tray.setContextMenu(menu());
      tray.on('click', openPanel);
      if (!preview) { startEngine(); }
      else {
        sendVoice({ state: 'idle', ready: false,
          question: 'Mam dziś dużo do zrobienia. Od czego zacząć?',
          answer: 'Zapisz zadania i wybierz te, które mają największe znaczenie. Nie musisz zrobić wszystkiego naraz.',
        });
        sendVoice({
        state: 'idle', ready: false,
        question: 'Jak mogę lepiej zaplanować dzień?',
        answer: 'Wybierz trzy najważniejsze zadania. Zacznij od jednego i zostaw trochę miejsca na przerwy.',
        });
      }
    }
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
