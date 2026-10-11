const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain, clipboard, dialog } = require('electron');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { createEngineSupervisor } = require('./engine-supervisor.cjs');
const { writeAtomic } = require('./atomic-file.cjs');
const orbGeometry = require('./orb-geometry.cjs');
const { createOverlayController } = require('./overlay-controller.cjs');
const { createWindowAdapter } = require('./desktop-windows.cjs');
const { registerDesktopIpc } = require('./desktop-ipc.cjs');
const { createWorkerEventReceiver } = require('./desktop-worker.cjs');
const { appDataDirectory } = require('./app-data.cjs');
const { conversationMarkdown } = require('./conversation-export.cjs');

const smokeTest = process.argv.includes('--smoke-test');
const dataDirectory = process.argv.includes('--preview')
  ? path.join(__dirname, '..', '.app-data') : appDataDirectory();
const imageDirectory = path.join(dataDirectory, 'images');
const outputDirectory = smokeTest ? process.env.TEST_OUTPUT_DIR || path.join(dataDirectory, 'captures')
  : path.join(__dirname, '..', '.app-data');
if (smokeTest) mkdirSync(outputDirectory, { recursive: true });
let savingConversation = false;
// Set these before Chromium initializes. Keep the orb away from other Electron
// profiles, and keep smoke tests away from an already-running desktop instance.
const profileDirectory = smokeTest || process.argv.includes('--preview')
  ? path.join(dataDirectory, 'electron', smokeTest ? `smoke-${process.pid}` : 'preview')
  : path.join(appDataDirectory(), 'electron', 'desktop');
const sessionDirectory = path.join(profileDirectory, 'session');
mkdirSync(sessionDirectory, { recursive: true });
app.setName('Voice Line');
app.setPath('userData', profileDirectory);
app.setPath('sessionData', sessionDirectory);
// Leave transparent space for entry/exit motion and Windows' minimum window size.
const WINDOW_SIZE = orbGeometry.windowWidth;
const WINDOW_HEIGHT = orbGeometry.windowHeight;
const MARGIN = 20;
const PANEL_MAX_HEIGHT = 500;
let orbWindow;
let tray;
let panelWindow;
let engine;
let voice = { state: 'starting', ready: false, question: '', answer: '', message: '',
  mode: process.argv.includes('--smoke-test') || process.argv.includes('--preview') ? 'local' : undefined };
const { createConversationPresentation } = require('./desktop-conversation.cjs');
const conversationPresentation = createConversationPresentation(voice);
const preview = process.argv.includes('--preview');
let testLiveVisibility = false;
let testNativePointer = false;
let pointerPoll;

function sendVoice(update = {}) {
  voice = conversationPresentation.update(update);
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
  const exchanges = structuredClone(conversationPresentation.completed);
  savingConversation = true;
  tray?.setContextMenu(menu());
  try {
    const markdown = await conversationMarkdown(exchanges, imageDirectory);
    const choice = await dialog.showSaveDialog(panelWindow, { title: 'Zapisz rozmowę', defaultPath: 'rozmowa.md',
      filters: [{ name: 'Rozmowa Markdown', extensions: ['md'] }] });
    if (choice.canceled || !choice.filePath) return 'cancelled';
    await writeAtomic(choice.filePath, markdown);
    await dialog.showMessageBox(panelWindow, { type: 'info', message: 'Zapisano rozmowę.',
      detail: 'Plik zawiera treść i obrazy. Automatyczne czyszczenie historii go nie usunie.', buttons: ['Zamknij'] });
    return 'saved';
  } catch {
    await dialog.showMessageBox(panelWindow, { type: 'error', message: 'Nie udało się zapisać rozmowy.',
      detail: 'Sprawdź dostępność obrazów i wybierz folder, w którym możesz zapisywać pliki. Następnie spróbuj ponownie.', buttons: ['Zamknij'] });
    return 'error';
  } finally { savingConversation = false; tray?.setContextMenu(menu()); }
}

const onEngineMessage = createWorkerEventReceiver({
  sendVoice, get voice() { return voice; },
  onLevel: level => orbWindow?.webContents.send('orb:level', level),
  compose: action => {
    if (action === 'correct' || action === 'continue') panelWindow?.webContents.send('voice:clear-draft');
    overlay.intent(action);
  },
});
const engineSupervisor = createEngineSupervisor({
  launch() {
    sendVoice({ state: 'starting', ready: false });
    return spawn(process.env.NODE_BIN || 'node',
    ['--env-file-if-exists=.env', '--experimental-strip-types', 'src/main.ts', '--desktop', ...(process.argv.includes('--debug') ? ['--debug'] : [])],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  },
  onChild(child) { engine = child && { get connected() { return child.connected; }, send: message => engineSupervisor.send(message) }; },
  canStart: () => !exitStarted && !smokeTest && !preview,
  onMessage: onEngineMessage,
  onError(error) {
    console.error(error);
    sendVoice({ state: 'error', ready: false, message: 'Nie można uruchomić aplikacji głosowej. Sprawdź instalację Node.js i spróbuj ponownie.' });
  },
  onStopped() {
    if (!exitStarted) sendVoice({ state: 'error', ready: false, message: 'Usługi głosowe zostały zatrzymane. Sprawdź ustawienia .env i szczegóły w terminalu, potem uruchom je ponownie.' });
  },
});
function startEngine() {
  if (!smokeTest && !preview && !exitStarted) engineSupervisor.start();
}

const overlay = createOverlayController({
  onChange(value, { focus }) {
    if (process.argv.includes('--debug')) console.log('[overlay]', { ...value, focus });
    if (panelWindow && !panelWindow.isDestroyed()) {
      if (value.mode === 'hidden') {
        if (panelWindow.isVisible()) windows.hidePanel();
      } else if (value.mode !== windows.mode || !panelWindow.isVisible() || focus) windows.openPanel(value.mode, focus);
      panelWindow.webContents.send('voice:pinned', value.pinned);
    }
    updateVisibility();
  },
});
function openPanel(focus = true) { overlay.open(Boolean(focus)); }
function hidePanel() { overlay.dismiss(); }
const windows = createWindowAdapter({
  screen, BrowserWindow, root: __dirname, position, PANEL_MAX_HEIGHT,
  get orbWindow() { return orbWindow; }, set orbWindow(value) { orbWindow = value; },
  get panelWindow() { return panelWindow; }, set panelWindow(value) { panelWindow = value; },
  hover: (surface, entered) => overlay.hover(surface, entered),
  menu, exiting: () => exitStarted, dismiss: hidePanel,
});
const positionPanel = animate => windows.positionPanel(animate);
const samplePointer = cursor => windows.samplePointer(cursor);
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

const disposeDesktopIpc = registerDesktopIpc(ipcMain, {
  clipboard, dialog, overlay, openPanel, hidePanel, positionPanel, sendVoice, finishExit,
  imageDirectory, panelHeights: windows.heights, PANEL_MAX_HEIGHT, smokeTest, preview, engineSupervisor,
  get orbWindow() { return orbWindow; }, get panelWindow() { return panelWindow; },
  get exitStarted() { return exitStarted; }, get voice() { return voice; }, get engine() { return engine; },
  get panelMode() { return windows.mode; },
  get panelHeight() { return windows.height; }, set panelHeight(value) { windows.height = value; },
  get panelResetTimer() { return windows.resetTimer; },
  get testNativePointer() { return testNativePointer; },
  set exitAcknowledged(value) { exitAcknowledged = value; },
});

app.on('will-quit', () => {
  disposeDesktopIpc();
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
  windows.dispose();
  clearTimeout(hideTimer);
  clearInterval(pointerPoll);
  if (!smokeTest && !preview) void engineSupervisor.stop();
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


if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openPanel);
  app.whenReady().then(async () => {
    await windows.create();
    if (exitStarted) return;
    if (!smokeTest) {
      pointerPoll = setInterval(() => {
        if (exitStarted || orbWindow.isDestroyed() || panelWindow.isDestroyed()) return;
        samplePointer();
      }, 50);
    }
    if (smokeTest) {
      try {
        await require('../tests/native/desktop-smoke.cjs').verifyDesktop({
          app, orbWindow, panelWindow, clipboard, dialog, nativeImage, profileDirectory, sessionDirectory,
          WINDOW_SIZE, WINDOW_HEIGHT, PANEL_MAX_HEIGHT, position, imageDirectory, outputDirectory,
          sendVoice, sendSettings, updateVisibility, onEngineMessage, openPanel, hidePanel,
          samplePointer, overlay, positionPanel, menu, saveCurrentConversation,
          get voice() { return voice; }, get panelHeight() { return windows.height; },
          get state() { return state; }, set state(value) { state = value; },
          get paused() { return paused; }, set paused(value) { paused = value; },
          get engine() { return engine; }, set engine(value) { engine = value; },
          set testLiveVisibility(value) { testLiveVisibility = value; },
          set testNativePointer(value) { testNativePointer = value; },
        });
        app.quit();
      }
      catch (error) { console.error(error); app.exit(1); }
    } else {
      tray = new Tray(trayImage());
      tray.setToolTip('Kulka głosowa');
      tray.setContextMenu(menu());
      tray.on('click', openPanel);
      if (!preview) { startEngine(); }
      else {
        sendVoice({ state: 'idle', ready: false, conversation: {
          id: 'preview', revision: 1, pending: null, completed: [
            { id: 'preview-1', revision: 1, question: 'Mam dziś dużo do zrobienia. Od czego zacząć?',
              answer: 'Zapisz zadania i wybierz te, które mają największe znaczenie. Nie musisz zrobić wszystkiego naraz.' },
            { id: 'preview-2', revision: 1, question: 'Jak mogę lepiej zaplanować dzień?',
              answer: 'Wybierz trzy najważniejsze zadania. Zacznij od jednego i zostaw trochę miejsca na przerwy.' },
          ],
        } });
      }
    }
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
