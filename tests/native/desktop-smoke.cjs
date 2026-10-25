const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDesktopFixture } = require('../helpers/desktop-fixture.cjs');

async function verifyDesktop(host) {
  const { app, panelWindow, clipboard, dialog, nativeImage, profileDirectory, sessionDirectory,
    PANEL_MAX_HEIGHT, imageDirectory, outputDirectory,
    sendSettings, openPanel, hidePanel,
    samplePointer, overlay, positionPanel, menu, saveCurrentConversation } = host;
  const fixture = createDesktopFixture();
  const { previousConversations } = fixture;
  const sendVoice = update => host.sendVoice(fixture.update(update));
  const onEngineMessage = message => {
    if (message?.type !== 'voice') return host.onEngineMessage(message);
    const snapshot = fixture.update(message);
    return host.onEngineMessage({ ...snapshot, type: 'voice', mode: snapshot.mode || 'local',
      ready: Boolean(snapshot.ready), health: snapshot.ready ? 'ready' : snapshot.state === 'error' ? 'error' : 'starting',
      capabilities: { text: { state: snapshot.ready ? 'ready' : snapshot.state === 'error' ? 'error' : 'starting' },
        recording: { state: 'ready' }, playback: { state: 'ready' } },
      threadId: snapshot.conversation.id, revision: snapshot.conversation.revision,
      operationId: null, canRestorePrevious: Boolean(snapshot.canRestorePrevious) });
  };
  const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => panelWindow.webContents.executeJavaScript(code);
  assert.equal(app.getPath('userData'), profileDirectory);
  assert.equal(app.getPath('sessionData'), sessionDirectory);
  assert.equal(panelWindow.webContents.session.getStoragePath(), sessionDirectory);
  assert.equal(require('electron').BrowserWindow.getAllWindows().length, 1);
  assert.equal(panelWindow.isAlwaysOnTop(), true);
  assert.equal(panelWindow.isVisible(), false, 'Conversation starts hidden');
  assert.equal(await evaluate('document.querySelector("#voice-mode").hidden'), true);
  sendVoice({ state: 'idle', ready: true });
  sendVoice({ state: 'listening', question: '', answer: '' });
  await wait(350);
  assert.equal(panelWindow.isVisible(), true, 'Recording reveals the panel');
  assert.equal(panelWindow.isFocused(), false, 'Automatic display does not steal focus');
  const area = host.screen.getPrimaryDisplay().workArea;
  const bounds = panelWindow.getBounds();
  assert.ok(Math.abs(bounds.x + bounds.width - (area.x + area.width - 20)) <= 2);
  assert.ok(Math.abs(bounds.y + bounds.height - (area.y + area.height - 20)) <= 2);
  for (const [mode, label] of [['realtime', 'API'], ['local', 'LOCAL']]) {
    sendVoice({ mode }); await wait();
    assert.equal(await evaluate('document.querySelector("#voice-mode").textContent'), label);
  }
  const audioLevel = () => evaluate('Number(document.querySelector("#audio-indicator").style.getPropertyValue("--audio-level"))');
  const originalFocus = panelWindow.isFocused();
  const originalOverlay = overlay.snapshot();
  panelWindow.webContents.debugger.attach('1.3');
  try {
    for (const variant of ['bars', 'orb', 'glow', 'waves']) {
      menu().items.find(item => item.label === 'Efekty wizualne').submenu.items.filter(item => item.type === 'radio')[['bars', 'orb', 'glow', 'waves'].indexOf(variant)].click();
      assert.equal(require('../../electron/visual-preferences.cjs').loadVisualPreferences(host.visualPreferencesFile).indicator, variant,
        'A fresh preferences read restores the choice made through the tray');
      assert.equal(menu().items.find(item => item.label === 'Efekty wizualne').submenu.items.filter(item => item.type === 'radio' && item.checked).length, 1,
        'Effects retain a single selected choice');
      sendVoice({ state: 'listening', question: 'Test audio', answer: '' });
      await panelWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      onEngineMessage({ type: 'level', source: 'listening', level: .12 });
      assert.ok(await audioLevel() > .3, variant + ': quiet microphone syllables respond immediately');
      onEngineMessage({ type: 'level', source: 'listening', level: 1 });
      await wait(450);
      assert.ok(await audioLevel() > .9, variant + ': measured audio drives feedback');
      assert.equal(await evaluate('document.querySelector("#audio-indicator").dataset.variant'), variant);
      assert.equal(panelWindow.isFocused(), originalFocus);
      assert.deepEqual(overlay.snapshot(), originalOverlay);
      if (variant === 'orb') {
        assert.equal(await evaluate('document.querySelector("voice-orb").clientWidth'), 24);
        assert.equal(await evaluate('document.querySelector("voice-orb").shadowRoot.querySelector(".sphere").classList.contains("rendered")'), true);
        await evaluate('window.previousAudioOrb = document.querySelector("voice-orb"); window.previousAudioRenderer = window.previousAudioOrb.renderer; void 0');
      } else assert.equal(await evaluate('document.querySelector("voice-orb") === null'), true);
      if (variant === 'glow') {
        assert.equal(await evaluate('window.previousAudioOrb.renderer === undefined && !window.previousAudioRenderer.program && !window.previousAudioRenderer.buffer && window.previousAudioRenderer.frame === 0'), true,
          'Switching away from the mini orb releases GPU resources and its animation loop');
      }
      if (variant === 'waves') {
        assert.equal(await evaluate('getComputedStyle(document.querySelector("#audio-waves")).height'), '40px');
        assert.equal(await evaluate('document.querySelector("voice-waves").shadowRoot.querySelector(".field").classList.contains("rendered")'), true,
          'Background waves reuse the working orb shader');
        assert.equal(await evaluate('(() => { const canvas = document.querySelector("voice-waves").shadowRoot.querySelector("canvas"); return canvas.width > canvas.height; })()'), true);
        await evaluate('window.previousWaveRenderer = document.querySelector("voice-waves").renderer; void 0');
      }
      const layout = await evaluate('(() => { const h = document.querySelector("#panel-header").getBoundingClientRect(); const m = document.querySelector("main").getBoundingClientRect(); return { bottom: h.bottom, top: m.top }; })()');
      assert.ok(layout.top >= layout.bottom);
      await fs.writeFile(path.join(outputDirectory, 'indicator-' + variant + '.png'), (await panelWindow.webContents.capturePage()).toPNG());
      onEngineMessage({ type: 'level', source: 'speaking', level: 0 }); await wait();
      assert.ok(await audioLevel() > .9, 'Foreign audio source is ignored');
      sendVoice({ state: 'speaking', answer: 'Test answer' }); await wait(100);
      assert.equal(await audioLevel(), 0, 'State transition resets the level');
      onEngineMessage({ type: 'level', source: 'speaking', level: .8 }); await wait(400);
      assert.ok(await audioLevel() > .7, 'Playback drives feedback');
      onEngineMessage({ type: 'level', source: 'speaking', level: 0 }); await wait(600);
      assert.ok(await audioLevel() < .01, 'Measured silence returns feedback to rest');
      host.paused = true; sendSettings(); await wait();
      assert.equal(await audioLevel(), 0);
      if (variant === 'waves') assert.equal(await evaluate('document.querySelector("voice-waves").renderer.frame'), 0);
      host.paused = false; sendSettings();
      await panelWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      onEngineMessage({ type: 'level', source: 'speaking', level: 1 }); await wait();
      assert.equal(await audioLevel(), 0, 'Reduced motion keeps feedback static');
      if (variant === 'waves') assert.equal(await evaluate('document.querySelector("voice-waves").renderer.frame'), 0);
      await fs.writeFile(path.join(outputDirectory, 'indicator-' + variant + '-reduced.png'), (await panelWindow.webContents.capturePage()).toPNG());
      await panelWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      onEngineMessage({ type: 'level', source: 'speaking', level: 1 }); await wait(400);
      hidePanel(); await wait();
      assert.equal(await audioLevel(), 0, 'Hiding resets the level');
      onEngineMessage({ type: 'level', source: 'speaking', level: 1 });
      openPanel(false); await wait();
      assert.equal(await audioLevel(), 0, 'Hidden audio cannot leak into the next display');
      sendVoice({ state: 'idle' });
      onEngineMessage({ type: 'level', source: 'speaking', level: 1 }); await wait();
      assert.equal(await audioLevel(), 0, 'Late audio cannot animate an idle panel');
    }
  } finally {
    await panelWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    panelWindow.webContents.debugger.detach();
  }
  host.indicator = 'bars'; sendSettings();
  await wait();
  assert.equal(await evaluate('!window.previousWaveRenderer.program && !window.previousWaveRenderer.buffer && window.previousWaveRenderer.frame === 0'), true,
    'Switching away from waves releases GPU resources');
  sendVoice({ state: 'idle' }); hidePanel();
  openPanel(false);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))'); await wait();
  assert.equal(panelWindow.isVisible(), false);
  console.log('Single panel, audio variants and reduced motion: passed');
  sendVoice({ state: 'thinking', question: 'Test <script>unsafe</script>' });
  const status = () => panelWindow.webContents.executeJavaScript(`(() => {
    const element = document.querySelector('#status');
    return { text: element.textContent, hidden: element.hidden, role: element.getAttribute('role') };
  })()`);
  assert.deepEqual(await status(), { text: 'Codex przygotowuje odpowiedź…', hidden: false, role: 'status' });
  sendVoice({ answer: 'Początek odpowiedzi…' });
  assert.equal((await status()).hidden, false, 'Partial answer does not hide generation feedback');
  sendVoice({ answer: '' });
  sendVoice({ state: 'speaking', answer: 'Odpowiedź testowa.' });
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
    const button = document.querySelector('#images .image-save');
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
  assert.equal(await panelWindow.webContents.executeJavaScript("window.voiceDesktop.imagePreview('../../.env')"), null);
  const originalSaveDialog = dialog.showSaveDialog;
  const savedImage = path.join(profileDirectory, 'image-save-test.png');
  const clickSaveImage = () => panelWindow.webContents.executeJavaScript(`(async () => {
    const button = document.querySelector('#images .image-save'); button.focus(); button.click();
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
  sendVoice({ state: 'idle' });
  console.log('Conversation capture: passed');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(panelWindow.isVisible(), false);
  openPanel(false);
  overlay.hover('panel', true); overlay.hover('panel', false);
  await wait(1100);
  assert.equal(panelWindow.isVisible(), true, 'Departure alone keeps the panel visible');
  hidePanel();
  sendVoice({ state: 'idle' });
  for (const state of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']) {
    sendVoice({ state }); await wait();
    assert.equal(panelWindow.isVisible(), true, state + ': active panel stays visible');
  }
  sendVoice({ state: 'idle' }); await wait(300);
  assert.equal(panelWindow.isVisible(), true);
  // This case checks unprotected expiry; the settled popup may have moved
  // underneath the stationary OS cursor while its content changed.
  overlay.hover('panel', false);
  overlay.composerFocus(false);
  await wait(5100);
  assert.equal(panelWindow.isVisible(), false, 'Completion hides the panel after five seconds');
  sendVoice({ state: 'error', ready: false, message: 'Sprawdź mikrofon.' });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#retry').hidden"), false);
  sendVoice({ state: 'idle', ready: true, reset: true });
  assert.equal(host.voice.history.length, 0, 'New conversation clears display history');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#empty').hidden"), false);
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  openPanel(false);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), true);
  const peekHeight = host.panelHeight;
  const peekContent = await panelWindow.webContents.executeJavaScript('document.querySelector("#panel").getBoundingClientRect().height');
  assert.ok(Math.abs(peekHeight - peekContent) <= 4, `Hover popup fits its content: ${peekHeight}, content ${peekContent}, requested ${host.panelHeight}`);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('h2') === null"), true);
  sendVoice({ answer: 'Dłuższa odpowiedź.\n'.repeat(12) });
  await new Promise(resolve => setTimeout(resolve, 350));
  const previousAnswerHeight = host.panelHeight;
  for (const state of ['listening', 'transcribing', 'thinking']) {
    sendVoice({ state, question: '', answer: '' });
    await new Promise(resolve => setTimeout(resolve, 350));
    const measured = await panelWindow.webContents.executeJavaScript('Math.ceil(document.querySelector("main").getBoundingClientRect().height + document.querySelector("#panel-header").getBoundingClientRect().height)');
    assert.ok(Math.abs(host.panelHeight - Math.max(64, measured + 2)) <= 2,
      `${state}: compact popup follows current content`);
    assert.ok(host.panelHeight < previousAnswerHeight, `${state}: old answer leaves no empty space`);
    assert.equal(panelWindow.isVisible(), true, `${state}: compact popup stays visible`);
  }
  sendVoice({ state: 'idle', question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  await new Promise(resolve => setTimeout(resolve, 350));
  onEngineMessage({ type: 'ui', action: 'compose' });
  await wait(350);
  assert.equal(await evaluate('document.body.dataset.mode'), 'compact');
  assert.equal(await evaluate('document.querySelector("#composer").hidden'), false);
  onEngineMessage({ type: 'ui', action: 'compose' });
  await wait(350);
  assert.equal(await evaluate('document.body.dataset.mode'), 'chat');
  const pointerBounds = panelWindow.getBounds();
  host.testNativePointer = true;
  samplePointer({ x: pointerBounds.x + 10, y: pointerBounds.y + 10 });
  samplePointer({ x: pointerBounds.x - 10, y: pointerBounds.y - 10 });
  host.testNativePointer = false;
  overlay.hover('panel', false);
  sendVoice({ state: 'idle' });
  const commands = [];
  console.log('Conversation mode checks: passed');
  host.engine = { connected: true, request: async message => {
    commands.push(message);
    if (message.command === 'previous') sendVoice({ state: 'thinking' });
    if (message.command === 'text') {
      sendVoice({ state: 'thinking', question: message.text, answer: '', questionSource: 'text' });
      host.onEngineMessage({ type: 'ui', action: 'text-input' });
    }
    return { accepted: true, operationId: 1 };
  } };
  previousConversations.clear();
  const savedExchanges = [{ question: 'Zapisane pytanie', answer: 'Zapisana odpowiedź' },
    { question: 'Kolejne zapisane pytanie', answer: 'Kolejna zapisana odpowiedź' }];
  onEngineMessage({ type: 'voice', state: 'idle', ready: true, threadId: 'saved-thread',
    canRestorePrevious: false, exchanges: savedExchanges });
  assert.equal(host.voice.question, savedExchanges[1].question, 'Startup displays the resumed thread latest question');
  assert.equal(host.voice.answer, savedExchanges[1].answer);
  assert.deepEqual(host.voice.history, savedExchanges.slice(0, -1));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#answer').textContent"), savedExchanges[1].answer);
  previousConversations.clear();
  onEngineMessage({ type: 'voice', state: 'idle', ready: true, threadId: 'expired-saved-thread',
    restored: true, canRestorePrevious: false, exchanges: savedExchanges });
  assert.equal(host.voice.answer, savedExchanges[1].answer, 'Undo loads messages even when the Electron archive is empty after restart');
  assert.deepEqual(host.voice.history, savedExchanges.slice(0, -1));
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
  assert.equal(host.voice.question, 'Drugie pytanie');
  assert.equal(host.voice.answer, 'Druga odpowiedź');
  assert.deepEqual(host.voice.history, [{ question: 'Pierwsze pytanie', answer: 'Pierwsza odpowiedź' }]);
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
  assert.equal(host.voice.answer, 'Druga odpowiedź');
  onEngineMessage({ type: 'voice', state: 'idle', threadId: 'undo-second', restored: true, canRestorePrevious: true });
  assert.equal(host.voice.answer, 'Nowa odpowiedź', 'Returning also preserves the conversation being left');
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
  sendVoice({ state: 'speaking' });
  sendVoice({ state: 'idle' });
  hidePanel();
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(panelWindow.isVisible(), true, 'Copilot tap opens the popup');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compose');
  assert.equal(await panelWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('main')).display"), 'none', 'Input-only mode hides the old conversation');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.activeElement.id"), 'message');
  assert.ok(await evaluate('document.querySelector("#panel").offsetHeight') <= 150, 'Input-only popup includes its compact header and image controls');
  assert.equal(await panelWindow.webContents.executeJavaScript('document.documentElement.scrollHeight <= innerHeight'), true);
  await fs.writeFile(path.join(outputDirectory, 'electron-conversation-compose.png'), (await panelWindow.webContents.capturePage()).toPNG());
  overlay.hover('panel', true);
  overlay.hover('panel', false);
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.hasFocus() && document.activeElement.id === 'message'"), true);
  assert.equal(panelWindow.isVisible(), true, 'Focused typing survives interrupted playback completion and pointer departure');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').blur()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.activeElement.id === 'message'"), false, 'Leaving the composer releases typing protection');
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(panelWindow.isVisible(), true, 'Leaving the composer alone does not hide the panel');
  hidePanel();
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  console.log('Copilot input-only mode checks: passed');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').click()");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(overlay.snapshot().pinned, true);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').getAttribute('aria-pressed')"), 'true');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').getAttribute('aria-label')"), 'Odepnij popup');
  assert.equal(await evaluate("document.querySelector('#pin').getBoundingClientRect().top - document.querySelector('#panel').getBoundingClientRect().top"), 4,
    'Pin stays at the visible panel header');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#pin svg') !== null"), true);
  overlay.hover('panel', true);
  overlay.hover('panel', false);
  panelWindow.blur();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), true, 'Pin preserves popup after blur and departure');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').click()");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), true, 'Unpin alone does not hide the panel');
  hidePanel();
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  console.log('Popup pin checks: passed');
  for (const window of [panelWindow]) {
    overlay.open(); overlay.togglePin();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(panelWindow.isVisible(), true);
    window.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(panelWindow.isDestroyed(), false, 'Native close must preserve the panel');
    assert.equal(panelWindow.isVisible(), false, 'Native close dismisses the pinned panel');
    assert.deepEqual(overlay.snapshot(), { mode: 'hidden', pinned: false });
  }
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(panelWindow.isVisible(), true, 'Dismissed windows can reopen');
  console.log('Panel native close checks: passed');
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
  const beforeVariantSwitch = structuredClone(host.voice);
  const beforeVariantOverlay = overlay.snapshot();
  for (const [index, variant] of ['bars', 'orb', 'glow', 'waves'].entries()) {
    menu().items.find(item => item.label === 'Efekty wizualne').submenu.items.filter(item => item.type === 'radio')[index].click();
    await wait();
    assert.equal(await evaluate('document.querySelector("#audio-indicator").dataset.variant'), variant);
    assert.equal(await evaluate('document.querySelector("#message").value'), 'Kontynuuj rozmowę');
    assert.equal(await evaluate('document.activeElement.id'), 'message');
    assert.deepEqual(host.voice, beforeVariantSwitch);
    assert.deepEqual(overlay.snapshot(), beforeVariantOverlay);
  }
  host.indicator = 'bars'; sendSettings();
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))");
  assert.equal(commands.length, 0, 'IME confirmation does not submit');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); document.querySelector('#composer').requestSubmit()");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(commands, [{ command: 'text', text: 'Kontynuuj rozmowę' }]);
  assert.equal(host.voice.question, 'Kontynuuj rozmowę');
  assert.equal(host.voice.answer, '', 'New question clears the previous reply');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact', 'Submitting from input-only mode reveals the latest turn and composer');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').hidden"), false, 'Answer preparation shows status text');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').textContent"), 'Codex przygotowuje odpowiedź…');
  assert.equal(host.voice.history.at(-1).question, 'Jak zaplanować dzień?', 'Previous exchange is retained');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  await panelWindow.webContents.executeJavaScript("window.voiceDesktop.command('cancel')");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(commands.at(-1).command, 'cancel');
  host.engine = undefined;
  sendVoice({ state: 'idle', ready: true });
  await fill('Zachowaj tę wiadomość');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').requestSubmit()");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Zachowaj tę wiadomość', 'Rejected messages preserve the draft');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#error').hidden"), false);
  let acknowledge;
  host.engine = { connected: true, request: () => new Promise(resolve => { acknowledge = resolve; }) };
  await fill('Czeka na potwierdzenie');
  await evaluate("document.querySelector('#composer').requestSubmit()");
  await wait(50);
  assert.equal(await evaluate("document.querySelector('#message').value"), 'Czeka na potwierdzenie', 'Draft survives until the worker accepts');
  assert.equal(host.voice.state, 'idle', 'Waiting for admission cannot invent a thinking state');
  await fill('Nowszy draft');
  acknowledge({ accepted: true, operationId: 2 });
  await wait(50);
  assert.equal(await evaluate("document.querySelector('#message').value"), 'Nowszy draft', 'An acknowledgement cannot erase edits made while it was in flight');
  host.engine = { connected: true, request: async () => ({ accepted: false, reason: 'busy' }) };
  await evaluate("document.querySelector('#composer').requestSubmit()"); await wait(50);
  assert.equal(await evaluate("document.querySelector('#message').value"), 'Nowszy draft', 'Worker rejection preserves the draft');
  sendVoice({ state: 'idle', ready: true, capabilities: {
    text: { state: 'ready' }, recording: { state: 'error', message: 'Mikrofon jest niedostępny. Możesz pisać.' }, playback: { state: 'ready' },
  } });
  assert.equal(await evaluate("document.querySelector('#retry').hidden"), false, 'Audio failures allow retry even while text is ready');
  assert.match(await evaluate("document.querySelector('#error').textContent"), /Możesz pisać/);
  sendVoice({ state: 'idle', ready: true, capabilities: {
    text: { state: 'ready' }, recording: { state: 'ready' }, playback: { state: 'ready' },
  } });
  host.onEngineMessage({ type: 'notice', source: 'shortcut', message: 'Skrót Copilot jest niedostępny. Możesz pisać.' });
  sendVoice({ state: 'idle', ready: true });
  assert.match(await evaluate("document.querySelector('#error').textContent"), /Skrót Copilot/);
  assert.equal(await evaluate("document.querySelector('#retry').hidden"), false, 'Shortcut failure survives service updates and offers retry');
  sendVoice({ inputMessage: '' });
  host.engine = undefined;
  console.log('Worker acknowledgement, draft preservation and degraded audio checks: passed');
  panelWindow.setSize(340, 420);
  sendVoice({ answer: 'Długa odpowiedź. '.repeat(300) });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight"), true);
  await panelWindow.webContents.executeJavaScript("document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').getBoundingClientRect().bottom <= innerHeight + 1"), true);
  // Windows DPI conversion can round native bounds by one or two DIP.
  assert.ok(panelWindow.getBounds().height <= PANEL_MAX_HEIGHT + 2, 'Long answers respect the popup height cap within native DPI rounding');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#audio-waves")).height'), '40px',
    'Expanding the conversation keeps waves at a fixed height');
  console.log('Text composer checks: passed');
  const chatOutput = path.join(outputDirectory, 'electron-conversation-chat.png');
  sendVoice({ state: 'idle', ready: true, question: 'Jak mogę lepiej zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania. Zacznij od jednego i zostaw trochę miejsca na przerwy.' });
  positionPanel();
  await panelWindow.webContents.executeJavaScript('document.querySelector("main").scrollTop = 0');
  openPanel();
  await new Promise(resolve => setTimeout(resolve, 350));
  await fs.writeFile(chatOutput, (await panelWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  const iconCompleted = [
    { id: 'icon-voice', revision: 1, question: 'Pytanie mówione', answer: 'Odpowiedź na pytanie mówione.', questionSource: 'voice', interrupted: true,
      inputImages: [{ id: imageId, alt: 'Obraz we wcześniejszym pytaniu' }] },
    { id: 'icon-text', revision: 1, question: 'Pytanie pisane', answer: 'Odpowiedź na pytanie pisane.', questionSource: 'text' },
    { id: 'icon-legacy', revision: 1, question: 'Starsze pytanie', answer: 'Odpowiedź bez informacji o źródle.' },
  ];
  host.sendVoice({ state: 'thinking', ready: true, message: 'Przykładowy komunikat błędu.',
    conversation: { id: 'icon-preview', revision: 1, completed: iconCompleted,
      pending: { id: 'icon-pending', revision: 1, question: 'Bieżące pytanie pisane', answer: '', questionSource: 'text',
        inputImages: [{ id: imageId, alt: 'Obraz w bieżącym pytaniu' }] } } });
  await new Promise(resolve => setTimeout(resolve, 250));
  const iconState = await panelWindow.webContents.executeJavaScript(`(() => {
    const icon = document.querySelector('#question-block > .message-icon');
    const style = getComputedStyle(icon);
    const row = getComputedStyle(icon.parentElement);
    return { current: icon.parentElement.dataset.messageIcon, label: icon.parentElement.getAttribute('aria-label'),
      history: [...document.querySelectorAll('#history .previous-question')].map(node => node.dataset.messageIcon),
      answers: document.querySelectorAll('#history .previous-answer > .message-icon').length,
      interruption: document.querySelector('.interrupted-status').dataset.messageIcon,
      status: document.querySelector('#status').dataset.messageIcon, error: document.querySelector('#error').dataset.messageIcon,
      width: style.width, height: style.height, opacity: style.opacity, gap: row.columnGap,
      decorative: icon.getAttribute('aria-hidden'), focusable: icon.getAttribute('focusable'),
      noOverflow: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  assert.deepEqual(iconState, { current: 'keyboard', label: 'Twoje pytanie pisane', history: ['mic', 'keyboard', 'question'],
    answers: 3, interruption: 'info', status: 'info', error: 'error', width: '14px', height: '14px', opacity: '0.65', gap: '8px',
    decorative: 'true', focusable: 'false', noOverflow: true });
  const inputAlignment = await evaluate(`(() => {
    const left = selector => document.querySelector(selector).getBoundingClientRect().left;
    return {
      current: Math.abs(left('#input-images .input-image-thumbnail') - left('#question')) <= 1,
      history: Math.abs(left('#history .input-image-thumbnail') - left('#history .previous-question > p')) <= 1,
    };
  })()`);
  assert.deepEqual(inputAlignment, { current: true, history: true }, 'Input image thumbnails align with question text in current and earlier messages');
  await panelWindow.webContents.executeJavaScript('document.querySelector("main").scrollTop = 0');
  await fs.writeFile(path.join(outputDirectory, 'electron-message-icons.png'), (await panelWindow.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
  host.sendVoice({ conversation: { id: 'icon-preview', revision: 2, completed: [{ ...iconCompleted[0], questionSource: 'text' }], pending: null } });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#question-block').dataset.messageIcon"), 'keyboard');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelectorAll('#answer-block > .message-icon').length"), 1);
  sendVoice();
  console.log('Message type icon checks: passed');
  for (let index = 0; index < 10; index++) {
    sendVoice({ state: 'idle', question: `Pytanie ${index}`, answer: 'Poprzednia odpowiedź. '.repeat(8) });
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(await panelWindow.webContents.executeJavaScript("document.querySelectorAll('#history .exchange').length") >= 10);
  assert.equal(await panelWindow.webContents.executeJavaScript('document.querySelector("main").scrollHeight > document.querySelector("main").clientHeight'), true, 'Expanded thread can scroll to earlier exchanges');
  await panelWindow.webContents.executeJavaScript('document.querySelector("main").scrollTop = 0');
  await new Promise(resolve => setTimeout(resolve, 50));
  sendVoice({ state: 'speaking' });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await panelWindow.webContents.executeJavaScript('document.querySelector("main").scrollTop'), 0, 'Status updates preserve reading position');
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
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 250));
  await fill('Szkic do zachowania');
  onEngineMessage({ type: 'ui', action: 'voice-input' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compose');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Szkic do zachowania');
  onEngineMessage({ type: 'ui', action: 'continue' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  const compactCapture = await panelWindow.webContents.capturePage();
  assert.equal(compactCapture.toBitmap()[3], 0, 'Unused viewport is transparent');
  await fs.writeFile(path.join(outputDirectory, 'electron-conversation-compact.png'), compactCapture.toPNG());
  await fill('Szkic\nz drugą linią');
  for (const expectedMode of ['chat', 'compact', 'chat']) {
    const nativeSizes = [];
    const initialBounds = panelWindow.getBounds();
    const originalSetBounds = panelWindow.setBounds;
    panelWindow.setBounds = function(bounds, ...args) {
      nativeSizes.push({ ...bounds });
      return originalSetBounds.call(this, bounds, ...args);
    };
    await evaluate(`(() => {
      const composer = document.querySelector('#composer');
      const transcript = document.querySelector('#transcript');
      const message = document.querySelector('#message');
      message.setSelectionRange(2, 5);
      window.transitionNodes = { composer, transcript, message };
      window.transitionFrames = [];
      const started = performance.now();
      function sample() {
        window.transitionFrames.push({
          composerBottom: innerHeight - composer.getBoundingClientRect().bottom,
          transcriptBottom: innerHeight - transcript.getBoundingClientRect().bottom,
          animation: getComputedStyle(composer).animationName,
        });
        if (performance.now() - started < 450) requestAnimationFrame(sample);
      }
      sample();
    })()`);
    overlay.toggle();
    await wait(500);
    panelWindow.setBounds = originalSetBounds;
    assert.equal(nativeSizes.length, 0, 'Mode switching never resizes the native viewport');
    assert.deepEqual(panelWindow.getBounds(), initialBounds, 'Native screen position stays fixed');
    const transition = await evaluate(`({ frames: window.transitionFrames,
      sameNodes: Object.entries(window.transitionNodes).every(([id, node]) => document.getElementById(id) === node),
      draft: document.querySelector('#message').value,
      selection: [document.querySelector('#message').selectionStart, document.querySelector('#message').selectionEnd],
      mode: document.body.dataset.mode })`);
    assert.equal(transition.mode, expectedMode);
    assert.equal(transition.sameNodes, true, 'Switching preserves message and composer nodes');
    assert.equal(transition.draft, 'Szkic\nz drugą linią');
    assert.deepEqual(transition.selection, [2, 5]);
    assert.ok(transition.frames.length > 2, 'Sample frames before and after resizing');
    const initial = transition.frames[0];
    for (const frame of transition.frames) {
      assert.ok(Math.abs(frame.composerBottom) <= 1, 'Composer stays at the native bottom throughout resizing');
      assert.ok(Math.abs(frame.transcriptBottom - initial.transcriptBottom) <= 2,
        `Latest message stays anchored during ${expectedMode}: ${frame.transcriptBottom} vs ${initial.transcriptBottom}`);
      assert.equal(frame.animation, 'none', 'Mode switches do not replay composer entry');
    }
  }
  console.log('Compact/chat transition anchoring checks: passed');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat');
  await fill('Szkic poprawki');
  onEngineMessage({ type: 'ui', action: 'correct' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  hidePanel();
  sendVoice({ state: 'starting', ready: false });
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').textContent"), 'Uruchamiam usługi…');
  assert.equal(await panelWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('main')).display !== 'none'"), true);
  hidePanel();
  sendVoice({ state: 'idle', ready: true });
  console.log('Copilot draft, correction and unavailable-state checks: passed');
  openPanel();
  // Select current and earlier images through the real preload/IPC boundary.
  host.engine = { connected: true, request: async () => ({ accepted: true, operationId: null }) };
  const secondBytes = nativeImage.createFromBitmap(Buffer.alloc(128 * 128 * 4, 180), { width: 128, height: 128 }).toPNG();
  const secondImageId = require('node:crypto').createHash('sha256').update(secondBytes).digest('hex');
  await fs.writeFile(path.join(imageDirectory, `${secondImageId}.png`), secondBytes);
  sendVoice({ state: 'idle', ready: true, threadId: 'image-selection', exchanges: [
    { question: 'Pierwszy obraz', answer: 'Gotowe', images: [{ id: imageId, alt: 'Pierwszy obraz' }] },
    { question: 'Drugi obraz', answer: 'Gotowe', images: [{ id: secondImageId, alt: 'Drugi obraz' }] },
  ] });
  await wait(300);
  await evaluate('document.querySelector("#images .image-select").click()');
  await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#images .image-select").getAttribute("aria-pressed")'), 'true');
  assert.equal(await evaluate('document.querySelector("#attachment-preview").naturalWidth'), 128);
  const imageActions = await evaluate(`(() => {
    const edit = document.querySelector('#images .image-select');
    const save = document.querySelector('#images .image-save');
    const left = edit.getBoundingClientRect(), right = save.getBoundingClientRect();
    return { icon: !!edit.querySelector('svg'), text: edit.textContent, adjacent: Math.abs(left.top - right.top) < 1 && right.left - left.right >= 3 && right.left - left.right <= 5 };
  })()`);
  assert.deepEqual(imageActions, { icon: true, text: '', adjacent: true });
  assert.equal(await evaluate('document.activeElement.id'), 'message');
  await evaluate('document.querySelector("#remove-attachment").click()');
  await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true);
  await evaluate('document.querySelector("#history .image-select").click()');
  await wait();
  assert.equal(await evaluate('document.querySelector("#attachment-preview").naturalWidth'), 256);
  assert.equal(await evaluate('document.querySelector("#images .image-select").getAttribute("aria-pressed")'), 'false');
  await fs.writeFile(path.join(outputDirectory, 'electron-image-selection.png'), (await panelWindow.webContents.capturePage()).toPNG());
  const imageCommands = [];
  let admitImage = false;
  host.engine = { connected: true, request: async message => {
    imageCommands.push(message);
    if (message.command === 'select-image') return { accepted: true, operationId: null };
    if (admitImage) sendVoice({ state: 'thinking', question: message.text, answer: '', selectedImageId: null });
    return { accepted: admitImage, operationId: admitImage ? 1 : null };
  } };
  await fill('Zmień tło');
  await evaluate('document.querySelector("#composer").requestSubmit()'); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), false, 'Rejected sends retain the selection');
  assert.equal(await evaluate('document.querySelector("#message").value'), 'Zmień tło');
  admitImage = true;
  await evaluate('document.querySelector("#composer").requestSubmit()'); await wait();
  assert.deepEqual(imageCommands.at(-1), { command: 'text', text: 'Zmień tło', imageId });
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true, 'Accepted text edits consume the attachment');
  assert.equal(await evaluate('document.querySelector("#message").value'), '');
  sendVoice({ state: 'error', message: 'Nie udało się edytować obrazu' }); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true, 'Generation failure does not restore a submitted attachment');
  sendVoice({ state: 'idle', answer: 'Gotowe', selectedImageId: null }); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true, 'Completed text edits clear the attachment, like voice edits');
  await fill('Zwykłe pytanie');
  await evaluate('document.querySelector("#composer").requestSubmit()'); await wait();
  assert.deepEqual(imageCommands.at(-1), { command: 'text', text: 'Zwykłe pytanie' });
  sendVoice({ state: 'idle', answer: 'Odpowiedź' });
  await evaluate('document.querySelector("#history .image-select").click()');
  await wait();
  assert.equal(imageCommands.at(-1).command, 'select-image');
  assert.equal(imageCommands.at(-1).imageId, imageId);
  await fill('Szkic\nz drugą linią');
  const inputLayout = () => evaluate(`(() => {
    const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    return { mode: document.body.dataset.mode, composer: rect('composer'), message: rect('message'),
      attachment: rect('image-attachment'), historyHidden: document.getElementById('history').hidden };
  })()`);
  const beforeVoice = await inputLayout();
  onEngineMessage({ type: 'ui', action: 'voice-input' });
  sendVoice({ state: 'listening', selectedImageId: imageId }); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), false, 'Voice recording retains the selected image');
  assert.deepEqual(await inputLayout(), beforeVoice, 'Voice input keeps the composer, attachment and conversation in place');
  assert.equal(await evaluate('document.querySelector("#composer-status").textContent'), 'Słucham…');
  assert.equal(await evaluate('document.querySelector("#status").hidden'), true, 'Voice status is shown only in the composer');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#message")).visibility'), 'hidden');
  await fs.writeFile(path.join(outputDirectory, 'electron-image-listening.png'), (await panelWindow.webContents.capturePage()).toPNG());
  sendVoice({ state: 'transcribing', selectedImageId: imageId }); await wait();
  assert.deepEqual(await inputLayout(), beforeVoice, 'Transcription keeps the same layout');
  assert.equal(await evaluate('document.querySelector("#composer-status").textContent'), 'Rozpoznaję mowę…');
  sendVoice({ state: 'idle', selectedImageId: imageId }); await wait();
  assert.deepEqual(await inputLayout(), beforeVoice, 'Returning to typing keeps the same layout');
  assert.equal(await evaluate('document.querySelector("#message").value'), 'Szkic\nz drugą linią');
  assert.equal(await evaluate('document.querySelector("#message").readOnly'), false);
  assert.equal(await evaluate('document.querySelector("#composer-status").hidden'), true);
  sendVoice({ state: 'thinking', question: 'Zmień tło', answer: '', selectedImageId: null }); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true, 'Submitted voice edits consume the attachment, like text edits');
  sendVoice({ state: 'idle', answer: 'Gotowe', selectedImageId: null }); await wait();
  await evaluate('document.querySelector("#history .image-select").click()'); await wait();
  sendVoice({ reset: true, threadId: 'after-image-selection' }); await wait();
  assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true, 'Changing conversations clears the selection');
  console.log('Manual image selection checks: passed');
  // Preview snapshots use the same canonical pending exchange as the worker.
  const variants = [{ id: imageId, alt: 'Wariant 1' }, { id: secondImageId, alt: 'Wariant 2' }];
  for (const [index, colour] of [[3, [70, 120, 210, 255]], [4, [190, 120, 70, 255]]]) {
    const pixels = Buffer.alloc(240 * 180 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(colour, offset);
    const bytes = nativeImage.createFromBitmap(pixels, { width: 240, height: 180 }).toPNG();
    const id = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(imageDirectory, `${id}.png`), bytes);
    variants.push({ id, alt: `Wariant ${index}` });
  }
  sendVoice({ reset: true, threadId: 'stream-gallery' });
  openPanel();
  sendVoice({ state: 'thinking', question: 'Wygeneruj obraz w 4 wariantach', answer: '', generatingImage: true, images: variants.slice(0, 1) });
  await wait(300);
  assert.equal(await evaluate('document.querySelector("#images .image-stage img").naturalWidth'), 256, 'First preview appears while generation is still running');
  await evaluate('window.firstGalleryImage = document.querySelector("#images .image-stage img")');
  sendVoice({ state: 'thinking', images: variants.slice(0, 2) }); await wait();
  assert.equal(await evaluate('document.querySelectorAll("#images .image-thumbnail").length'), 2);
  assert.equal(await evaluate('window.firstGalleryImage === document.querySelector("#images .image-stage img")'), true, 'New variants keep the existing large preview node');
  await evaluate('document.querySelectorAll("#images .image-thumbnail")[1].click()'); await wait();
  assert.equal(await evaluate('document.querySelector("#images .image-stage img").naturalWidth'), 128);
  await evaluate('window.selectedGalleryImage = document.querySelector("#images .image-stage img"); document.querySelectorAll("#images .image-thumbnail")[1].focus()');
  sendVoice({ state: 'thinking', images: variants.slice(0, 3) }); await wait();
  assert.equal(await evaluate('window.selectedGalleryImage === document.querySelector("#images .image-stage img")'), true, 'Streaming preserves the chosen variant');
  assert.equal(await evaluate('document.activeElement === document.querySelectorAll("#images .image-thumbnail")[1]'), true, 'Streaming preserves thumbnail focus');
  sendVoice({ state: 'thinking', images: variants }); await wait();
  assert.equal(await evaluate('document.querySelectorAll("#images .generated-image").length'), 1, 'Gallery displays one large image');
  assert.equal(await evaluate('document.querySelector("#images .image-thumbnails").getBoundingClientRect().bottom <= document.querySelector("#images .image-stage").getBoundingClientRect().top'), true);
  assert.equal(await evaluate('document.querySelector("#images .image-select").disabled'), true, 'Pending previews cannot be attached to another operation');
  await evaluate('document.querySelectorAll("#images .image-thumbnail")[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))'); await wait();
  assert.equal(await evaluate('document.querySelectorAll("#images .image-thumbnail")[2].getAttribute("aria-pressed")'), 'true');
  await fs.writeFile(path.join(outputDirectory, 'electron-image-gallery-streaming.png'), (await panelWindow.webContents.capturePage()).toPNG());
  sendVoice({ state: 'idle', answer: 'Wygenerowano obrazy.', generatingImage: false, images: variants }); await wait();
  assert.equal(await evaluate('document.querySelectorAll("#images .image-thumbnail")[2].getAttribute("aria-pressed")'), 'true', 'Completion preserves the chosen variant');
  await evaluate('document.querySelector("#images .image-select").click()'); await wait();
  assert.equal(imageCommands.at(-1).imageId, variants[2].id, 'Attach action targets the displayed variant');
  await fs.writeFile(path.join(outputDirectory, 'electron-image-gallery.png'), (await panelWindow.webContents.capturePage()).toPNG());
  console.log('Progressive image gallery checks: passed');
  await require('./history-scale.cjs').verifyHistoryScale({ panelWindow, outputDirectory, imageId });
  await require('./desktop-imports.cjs').verifyImageImports(host);
  console.log(JSON.stringify({ result: 'passed', profile: profileDirectory,
    cache: sessionDirectory, bounds: panelWindow.getBounds(), captures: outputDirectory }));
}

module.exports = { verifyDesktop };
