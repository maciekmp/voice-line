const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');

const smokeTest = process.argv.includes('--smoke-test');
// Set these before Chromium initializes. Keep the orb away from other Electron
// profiles, and keep smoke tests away from an already-running desktop instance.
const profileDirectory = path.join(__dirname, '..', '.chatgpt-button', 'electron',
  smokeTest ? `smoke-${process.pid}` : 'desktop');
const sessionDirectory = path.join(profileDirectory, 'session');
mkdirSync(sessionDirectory, { recursive: true });
app.setName('Voice Line Orb');
app.setPath('userData', profileDirectory);
app.setPath('sessionData', sessionDirectory);
// Leave transparent space for entry/exit motion and Windows' minimum window size.
const WINDOW_SIZE = 64;
const MARGIN = 20;
let orbWindow;
let tray;
let state = 'idle';
let paused = false;
let exitStarted = false;
let exitFinished = false;
let exitAcknowledged = false;
let exitTimer;

function finishExit() {
  if (!exitStarted || exitFinished) return;
  exitFinished = true;
  clearTimeout(exitTimer);
  app.quit();
}

ipcMain.on('orb:ready', event => {
  if (!orbWindow || event.sender !== orbWindow.webContents) return;
  orbWindow.showInactive();
  orbWindow.webContents.send('orb:presence', 'visible');
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
  exitTimer = setTimeout(finishExit, 700);
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
}

function menu() {
  return Menu.buildFromTemplate([
    ...[['idle', 'Spoczynek'], ['listening', 'Słuchanie (test)'], ['speaking', 'Mówienie (test)']].map(([value, label]) => ({
      label, type: 'radio', checked: state === value,
      click: () => { state = value; sendSettings(); },
    })),
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
  assert.deepEqual(orbWindow.getBounds(), { ...position(), width: WINDOW_SIZE, height: WINDOW_SIZE });
  state = 'listening'; sendSettings();
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  const listening = await inspect();
  assert.equal(listening.state, 'listening');
  const reducedMotion = await orbWindow.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(listening.animation, reducedMotion ? 'none' : 'listen-breathe');
  state = 'speaking'; paused = true; sendSettings();
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  const changed = await inspect();
  assert.equal(changed.state, 'speaking');
  assert.equal(changed.paused, true);
  assert.equal(changed.animation, reducedMotion ? 'none' : 'speak-breathe');
  const output = path.join(__dirname, '..', '.chatgpt-button', 'electron-orb.png');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, (await orbWindow.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({ result: 'passed', ...initial, profile: profileDirectory,
    cache: sessionDirectory, bounds: orbWindow.getBounds(), screenshot: output }));
}

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    orbWindow = new BrowserWindow({
      ...position(), width: WINDOW_SIZE, height: WINDOW_SIZE,
      title: 'Kulka głosowa', frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, alwaysOnTop: true,
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false, contextIsolation: true, sandbox: true,
      },
    });
    orbWindow.setMenu(null);
    orbWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    orbWindow.webContents.on('will-navigate', event => event.preventDefault());
    orbWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    orbWindow.webContents.on('context-menu', () => menu().popup({ window: orbWindow }));
    const reposition = () => {
      if (!orbWindow.isDestroyed()) { const { x, y } = position(); orbWindow.setPosition(x, y); }
    };
    screen.on('display-metrics-changed', reposition);
    screen.on('display-added', reposition);
    screen.on('display-removed', reposition);
    await orbWindow.loadFile(path.join(__dirname, 'orb.html'));
    if (smokeTest) {
      try { await verify(); app.quit(); }
      catch (error) { console.error(error); app.exit(1); }
    } else {
      tray = new Tray(trayImage());
      tray.setToolTip('Kulka głosowa');
      tray.setContextMenu(menu());
    }
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
