const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { mkdirSync } = require('node:fs');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

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
let panelWindow;
let engine;
let voice = { state: 'starting', ready: false, question: '', answer: '', message: '' };
const preview = process.argv.includes('--preview');

function sendVoice(update = {}) {
  if (update.reset) update = { ...update, question: '', answer: '' };
  voice = { ...voice, message: '', ...update };
  state = voice.state === 'listening' ? 'listening' : voice.state === 'speaking' ? 'speaking' : 'idle';
  for (const window of [orbWindow, panelWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('voice:snapshot', voice);
  }
  tray?.setToolTip(`Voice Line: ${voice.state}`);
  sendSettings();
}

function startEngine() {
  if (engine || smokeTest || preview) return;
  sendVoice({ state: 'starting', ready: false });
  const child = spawn(process.env.VOICE_LINE_NODE || 'node',
    ['--env-file-if-exists=.env', '--experimental-strip-types', 'src/main.ts', '--desktop', ...(process.argv.includes('--debug') ? ['--debug'] : [])],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
  engine = child;
  child.on('message', message => {
    if (engine === child && message?.type === 'voice') sendVoice(message);
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

function openPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.show(); panelWindow.focus();
}
function trusted(event) {
  return [orbWindow, panelWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
}
ipcMain.on('voice:open', event => { if (trusted(event)) openPanel(); });
ipcMain.on('voice:command', (event, command) => {
  if (!trusted(event) || exitStarted) return;
  if (command === 'hide') { panelWindow?.hide(); return; }
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
  if (!orbWindow || orbWindow.isDestroyed() || exitStarted || (!force && (smokeTest || preview))) return;
  clearTimeout(hideTimer);
  const active = ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(voice.state);
  if (active) {
    orbWindow.showInactive();
    orbWindow.webContents.send('orb:presence', 'visible');
  } else {
    orbWindow.webContents.send('orb:presence', 'hidden');
    hideTimer = setTimeout(() => { if (!orbWindow.isDestroyed()) orbWindow.hide(); }, 260);
  }
}

function finishExit() {
  if (!exitStarted || exitFinished) return;
  exitFinished = true;
  clearTimeout(exitTimer);
  app.quit();
}

ipcMain.on('orb:ready', event => {
  if (panelWindow && event.sender === panelWindow.webContents) { sendVoice(); return; }
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
  if (engine?.connected) engine.send({ command: 'shutdown' });
  panelWindow?.hide();
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
  updateVisibility();
}

function menu() {
  return Menu.buildFromTemplate([
    { label: 'Otwórz rozmowę', click: openPanel },
    ...(!preview ? [
      { label: 'Przerwij', enabled: voice.ready, click: () => engine?.connected && engine.send({ command: 'cancel' }) },
      { label: 'Nowa rozmowa', enabled: voice.ready, click: () => engine?.connected && engine.send({ command: 'reset' }) },
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
  // Exercise real snapshots in both sandboxed renderers without opening a microphone.
  sendVoice({ state: 'idle', ready: true }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Orb stays hidden while idle');
  sendVoice({ state: 'listening', question: '', answer: '' }); updateVisibility(true);
  assert.equal(orbWindow.isVisible(), true, 'Recording reveals the orb');
  sendVoice({ state: 'thinking', question: 'Test <script>unsafe</script>' }); updateVisibility(true);
  assert.equal(orbWindow.isVisible(), true, 'Processing keeps the orb visible');
  sendVoice({ state: 'speaking', answer: 'Odpowiedź testowa.' }); updateVisibility(true);
  const panel = await panelWindow.webContents.executeJavaScript(`(() => ({
    status: document.querySelector('#status').textContent,
    question: document.querySelector('#question').textContent,
    unsafe: document.querySelector('#question script') !== null,
    answer: document.querySelector('#answer').textContent,
    cancelDisabled: document.querySelector('#cancel').disabled,
  }))()`);
  assert.equal(panel.status, 'Odczytuję odpowiedź…');
  assert.equal(panel.unsafe, false);
  assert.equal(panel.answer, 'Odpowiedź testowa.');
  assert.equal(panel.cancelDisabled, false);
  const panelOutput = path.join(__dirname, '..', '.chatgpt-button', 'electron-conversation.png');
  await fs.writeFile(panelOutput, (await panelWindow.webContents.capturePage()).toPNG());
  sendVoice({ state: 'idle' }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Orb disappears when playback finishes');
  sendVoice({ state: 'error', ready: false, message: 'Sprawdź mikrofon.' });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#record').textContent"), 'Uruchom usługi ponownie');
  sendVoice({ state: 'idle', ready: true, reset: true });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#empty').hidden"), false);
  const commands = [];
  engine = { connected: true, send: message => commands.push(message.command) };
  await panelWindow.webContents.executeJavaScript("document.querySelector('#record').click()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(commands.pop(), 'record');
  sendVoice({ state: 'listening' });
  await panelWindow.webContents.executeJavaScript("document.querySelector('#record').click()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(commands.pop(), 'release');
  sendVoice({ state: 'thinking' });
  await panelWindow.webContents.executeJavaScript("document.querySelector('#cancel').click(); document.querySelector('#reset').click()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(commands, ['cancel', 'reset']);
  engine = undefined;
  sendVoice({ state: 'idle' });
  await panelWindow.webContents.executeJavaScript("document.querySelector('#record').focus()");
  assert.equal(await panelWindow.webContents.executeJavaScript("document.activeElement.id"), 'record');
  panelWindow.setSize(340, 420);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth"), true);
  sendVoice({ answer: 'Długa odpowiedź. '.repeat(300) });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight > innerHeight"), true);
  await panelWindow.webContents.executeJavaScript("scrollTo(0, document.documentElement.scrollHeight)");
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#record').getBoundingClientRect().bottom <= innerHeight"), true);
  orbWindow.showInactive();
  orbWindow.webContents.send('orb:presence', 'visible');
  const output = path.join(__dirname, '..', '.chatgpt-button', 'electron-orb.png');
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
    panelWindow = new BrowserWindow({
      width: 440, height: 620, minWidth: 340, minHeight: 420,
      title: 'Voice Line — rozmowa', show: false, backgroundColor: '#f6f8fc',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    panelWindow.setMenu(null);
    panelWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    panelWindow.webContents.on('will-navigate', event => event.preventDefault());
    panelWindow.on('close', event => { if (!exitStarted) { event.preventDefault(); panelWindow.hide(); } });
    await panelWindow.loadFile(path.join(__dirname, 'conversation.html'));
    if (smokeTest) {
      try { await verify(); app.quit(); }
      catch (error) { console.error(error); app.exit(1); }
    } else {
      tray = new Tray(trayImage());
      tray.setToolTip('Kulka głosowa');
      tray.setContextMenu(menu());
      tray.on('click', openPanel);
      if (!preview) { openPanel(); startEngine(); }
      else sendVoice({ state: 'idle', ready: false, message: 'Podgląd animacji. Uruchom npm start, aby rozpocząć rozmowę.' });
    }
  }).catch(error => { console.error(error); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
