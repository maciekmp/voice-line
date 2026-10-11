const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createDesktopFixture } = require('../helpers/desktop-fixture.cjs');

async function verifyDesktop(host) {
  const { app, orbWindow, panelWindow, clipboard, dialog, nativeImage, profileDirectory, sessionDirectory,
    WINDOW_SIZE, WINDOW_HEIGHT, PANEL_MAX_HEIGHT, position, imageDirectory, outputDirectory,
    sendSettings, updateVisibility, openPanel, hidePanel,
    samplePointer, overlay, positionPanel, menu, saveCurrentConversation } = host;
  const fixture = createDesktopFixture();
  const { previousConversations } = fixture;
  const sendVoice = update => host.sendVoice(fixture.update(update));
  const onEngineMessage = message => {
    if (message?.type !== 'voice') return host.onEngineMessage(message);
    const snapshot = fixture.update(message);
    return host.onEngineMessage({ ...snapshot, type: 'voice', mode: snapshot.mode || 'local',
      ready: Boolean(snapshot.ready), health: snapshot.ready ? 'ready' : snapshot.state === 'error' ? 'error' : 'starting',
      threadId: snapshot.conversation.id, revision: snapshot.conversation.revision,
      operationId: null, canRestorePrevious: Boolean(snapshot.canRestorePrevious) });
  };
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
  orbWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await orbWindow.webContents.executeJavaScript("Number(getComputedStyle(document.querySelector('voice-orb')).opacity)"), .9);
  orbWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 32, y: 32 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await orbWindow.webContents.executeJavaScript("Number(getComputedStyle(document.querySelector('voice-orb')).opacity)"), 1, 'Hover restores full orb opacity');
  assert.equal(await orbWindow.webContents.executeJavaScript("getComputedStyle(document.querySelector('button')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'Hover has no background highlight');
  orbWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
  hidePanel();
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
      const orbBounds = document.querySelector('voice-orb').getBoundingClientRect();
      return { text: label.textContent, hidden: label.hidden, bottom: bounds.bottom,
        overlaps: bounds.left < orbBounds.right && bounds.top < orbBounds.bottom && bounds.bottom > orbBounds.top,
        right: bounds.right, orbRight: orbBounds.right, opacity: Number(getComputedStyle(label).opacity),
        insideOrb: label.parentElement === document.querySelector('voice-orb'),
        slotted: label.assignedSlot?.name === 'overlay',
        buttonTop: document.querySelector('button').getBoundingClientRect().top };
    })()`);
    assert.equal(indicator.text, label);
    assert.equal(indicator.hidden, false);
    assert.equal(indicator.overlaps, true, 'Mode label overlaps the lower-right edge of the orb');
    assert.ok(indicator.right >= indicator.orbRight);
    assert.equal(indicator.opacity, .9, 'Label remains readable while sharing its orb parent hover effect');
    assert.equal(indicator.insideOrb && indicator.slotted, true, 'Label belongs to the orb structure');
    assert.ok(indicator.bottom <= WINDOW_HEIGHT);
    assert.equal(indicator.buttonTop, 5);
  }
  assert.equal(panelWindow.isVisible(), false, 'Conversation starts hidden');
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter'))");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(panelWindow.isVisible(), false, 'Hover cannot open hidden surfaces');
  openPanel(false);
  await new Promise(resolve => setTimeout(resolve, 350));
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
  assert.equal(panelWindow.isVisible(), true, 'Departure alone never closes the popup');
  hidePanel();
  openPanel(false);
  await panelWindow.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(panelWindow.isVisible(), false, 'Escape closes the popup');
  host.state = 'listening'; sendSettings();
  console.log('Popup hover checks: passed');
  await orbWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  const listening = await inspect();
  assert.equal(listening.state, 'listening');
  const reducedMotion = await orbWindow.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(listening.animation, 'none', 'Desktop uses the measured audio envelope');
  host.state = 'speaking'; host.paused = true; sendSettings();
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
  host.paused = false; sendSettings();
  onEngineMessage({ type: 'level', source: 'listening', level: .12 });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.ok(reducedMotion ? await audioScale() === 1 : await audioScale() > 1.05, 'Quiet syllables visibly grow the orb quickly');
  onEngineMessage({ type: 'level', source: 'listening', level: 1 });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(reducedMotion ? await audioScale() === 1 : await audioScale() > 1.15, 'Loud speech grows the orb');
  assert.ok(await audioScale() <= 1.201, 'Loud speech stays inside the fixed desktop hit area');
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
  const status = () => panelWindow.webContents.executeJavaScript(`(() => {
    const element = document.querySelector('#status');
    return { text: element.textContent, hidden: element.hidden, role: element.getAttribute('role') };
  })()`);
  assert.deepEqual(await status(), { text: 'Codex przygotowuje odpowiedź…', hidden: false, role: 'status' });
  sendVoice({ answer: 'Początek odpowiedzi…' });
  assert.equal((await status()).hidden, false, 'Partial answer does not hide generation feedback');
  sendVoice({ answer: '' });
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
  host.paused = true; sendSettings();
  assert.equal((await ring()).paused, 'paused');
  host.paused = false; sendSettings();
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
  openPanel(false);
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
  assert.equal(orbWindow.isVisible(), true, 'Departure alone keeps both surfaces visible');
  hidePanel();
  updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Explicit dismissal hides both surfaces');
  for (const activeState of ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']) {
    sendVoice({ state: activeState }); updateVisibility(true);
    await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerenter')); document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
    await new Promise(resolve => setTimeout(resolve, 1400));
    updateVisibility(true);
    assert.equal(panelWindow.isVisible(), true, `${activeState}: departure preserves popup`);
    assert.equal(orbWindow.isVisible(), true, `${activeState}: departure cannot hide active orb`);
  }
  sendVoice({ state: 'idle' }); updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(panelWindow.isVisible(), true, 'Completion retains popup briefly after playback');
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(panelWindow.isVisible(), false, 'Completion hides popup after five seconds');
  updateVisibility(true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(orbWindow.isVisible(), false, 'Completion hides orb after grace and exit animation');
  console.log('Active voice departure checks: passed');
  sendVoice({ state: 'error', ready: false, message: 'Sprawdź mikrofon.' });
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#retry').hidden"), false);
  sendVoice({ state: 'idle', ready: true, reset: true });
  assert.equal(host.voice.history.length, 0, 'New conversation clears display history');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#empty').hidden"), false);
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  openPanel(false);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), true);
  const peekHeight = panelWindow.getBounds().height;
  const peekContent = await panelWindow.webContents.executeJavaScript('document.body.getBoundingClientRect().height');
  assert.ok(Math.abs(peekHeight - peekContent) <= 4, `Hover popup fits its content: ${peekHeight}, content ${peekContent}, requested ${host.panelHeight}`);
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('h2') === null"), true);
  sendVoice({ answer: 'Dłuższa odpowiedź.\n'.repeat(12) });
  await new Promise(resolve => setTimeout(resolve, 350));
  const previousAnswerHeight = panelWindow.getBounds().height;
  for (const state of ['listening', 'transcribing', 'thinking']) {
    sendVoice({ state, question: '', answer: '' });
    await new Promise(resolve => setTimeout(resolve, 350));
    const measured = await panelWindow.webContents.executeJavaScript('Math.ceil(document.querySelector("main").getBoundingClientRect().height)');
    assert.ok(Math.abs(panelWindow.getBounds().height - Math.max(64, measured + 2)) <= 2,
      `${state}: compact popup follows current content`);
    assert.ok(panelWindow.getBounds().height < previousAnswerHeight, `${state}: old answer leaves no empty space`);
    assert.equal(panelWindow.isVisible(), true, `${state}: compact popup stays visible`);
  }
  sendVoice({ state: 'idle', question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  await new Promise(resolve => setTimeout(resolve, 350));
  host.testLiveVisibility = true;
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
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value = 'Zachowany szkic'");
  orbWindow.webContents.sendInputEvent({ type: 'mouseDown', x: 32, y: 32, button: 'left', clickCount: 1 });
  orbWindow.webContents.sendInputEvent({ type: 'mouseUp', x: 32, y: 32, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'chat', 'Second orb click exposes history');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  assert.ok(panelWindow.getBounds().height > peekHeight, 'Expanded writing keeps the composer available');
  assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true, 'Collapse keeps both hovered surfaces visible');
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').click()");
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact', 'Keyboard activation returns to compact writing');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Zachowany szkic', 'Toggle preserves the draft');
  host.testNativePointer = true;
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
  host.testNativePointer = false;
  overlay.hover('panel', false);
  openPanel();
  sendVoice({ question: 'Jak zaplanować dzień?', answer: 'Wybierz trzy najważniejsze zadania i zacznij od jednego.' });
  host.testLiveVisibility = false;
  await orbWindow.webContents.executeJavaScript("document.querySelector('button').dispatchEvent(new PointerEvent('pointerleave'))");
  sendVoice({ state: 'idle' });
  const commands = [];
  console.log('Conversation mode checks: passed');
  host.engine = { connected: true, send: message => commands.push(message) };
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
  host.testLiveVisibility = true;
  sendVoice({ state: 'speaking' });
  sendVoice({ state: 'idle' });
  hidePanel();
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
  overlay.hover('orb', false);
  overlay.hover('panel', true);
  overlay.hover('panel', false);
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.hasFocus() && document.activeElement.id === 'message'"), true);
  assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true, 'Focused typing survives interrupted playback completion and pointer departure');
  panelWindow.blur();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(panelWindow.isFocused(), false, 'Native popup releases keyboard focus');
  assert.equal(await panelWindow.webContents.executeJavaScript('document.hasFocus()'), false, 'Renderer observes native blur');
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true, 'Window blur alone does not hide surfaces');
  hidePanel();
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  host.testLiveVisibility = false;
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
  orbWindow.focus();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), true, 'Pin preserves popup after blur and departure');
  await panelWindow.webContents.executeJavaScript("document.querySelector('#pin').click()");
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(panelWindow.isVisible(), true, 'Unpin alone does not hide surfaces');
  hidePanel();
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  console.log('Popup pin checks: passed');
  host.testLiveVisibility = true;
  for (const window of [orbWindow, panelWindow]) {
    overlay.open(); overlay.togglePin();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true);
    window.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(orbWindow.isDestroyed() || panelWindow.isDestroyed(), false, 'Native close must preserve both windows');
    assert.equal(orbWindow.isVisible() || panelWindow.isVisible(), false, 'Native close dismisses both pinned surfaces');
    assert.deepEqual(overlay.snapshot(), { mode: 'hidden', pinned: false, orbVisible: false });
  }
  overlay.compose();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(panelWindow.isVisible() && orbWindow.isVisible(), true, 'Dismissed windows can reopen');
  host.testLiveVisibility = false;
  console.log('Paired native close checks: passed');
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
  assert.equal(host.voice.question, 'Kontynuuj rozmowę');
  assert.equal(host.voice.answer, '', 'New question clears the previous reply');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact', 'Submitting from input-only mode reveals the latest turn and composer');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').hidden"), false, 'Answer preparation shows status text');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#status').textContent"), 'Codex przygotowuje odpowiedź…');
  assert.equal(host.voice.history.at(-1).question, 'Jak zaplanować dzień?', 'Previous exchange is retained');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  await panelWindow.webContents.executeJavaScript("window.orbDesktop.command('cancel')");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(commands.at(-1).command, 'cancel');
  host.engine = undefined;
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
  const iconCompleted = [
    { id: 'icon-voice', revision: 1, question: 'Pytanie mówione', answer: 'Odpowiedź na pytanie mówione.', questionSource: 'voice', interrupted: true },
    { id: 'icon-text', revision: 1, question: 'Pytanie pisane', answer: 'Odpowiedź na pytanie pisane.', questionSource: 'text' },
    { id: 'icon-legacy', revision: 1, question: 'Starsze pytanie', answer: 'Odpowiedź bez informacji o źródle.' },
  ];
  host.sendVoice({ state: 'thinking', ready: true, message: 'Przykładowy komunikat błędu.',
    conversation: { id: 'icon-preview', revision: 1, completed: iconCompleted,
      pending: { id: 'icon-pending', revision: 1, question: 'Bieżące pytanie pisane', answer: '', questionSource: 'text' } } });
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
  await panelWindow.webContents.executeJavaScript('scrollTo(0, 0)');
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
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 250));
  await fill('Szkic do zachowania');
  onEngineMessage({ type: 'ui', action: 'voice-input' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'peek');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), 'Szkic do zachowania');
  onEngineMessage({ type: 'ui', action: 'continue' });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await panelWindow.webContents.executeJavaScript("document.body.dataset.mode"), 'compact');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#message').value"), '');
  assert.equal(await panelWindow.webContents.executeJavaScript("document.querySelector('#composer').hidden"), false);
  await fs.writeFile(path.join(outputDirectory, 'electron-conversation-compact.png'), (await panelWindow.webContents.capturePage()).toPNG());
  onEngineMessage({ type: 'ui', action: 'compose' });
  await new Promise(resolve => setTimeout(resolve, 250));
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
  orbWindow.showInactive();
  orbWindow.webContents.send('orb:presence', 'visible');
  await new Promise(resolve => setTimeout(resolve, 150));
  const output = path.join(outputDirectory, 'electron-orb.png');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, (await orbWindow.webContents.capturePage()).toPNG());
  openPanel();
  await require('./history-scale.cjs').verifyHistoryScale({ panelWindow, outputDirectory, imageId });
  console.log(JSON.stringify({ result: 'passed', ...initial, profile: profileDirectory,
    cache: sessionDirectory, bounds: orbWindow.getBounds(), screenshot: output }));
}

module.exports = { verifyDesktop };
