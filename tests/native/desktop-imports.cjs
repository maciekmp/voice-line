const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow, ipcMain } = require('electron');
const { createScreenCapture } = require('../../electron/screen-capture.cjs');

async function verifyImageImports(host) {
  const { panelWindow, imageDirectory, dialog, clipboard, nativeImage, overlay, screen } = host;
  await fs.mkdir(imageDirectory, { recursive: true });
  const evaluate = code => panelWindow.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(check, label) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await wait(20); }
    assert.fail(label);
  }
  const originalEngine = host.engine, originalPicker = dialog.showOpenDialog, originalClipboard = clipboard.readImage;
  const originalCapture = host.screenCapture.capture;
  const originalLoadFile = BrowserWindow.prototype.loadFile;
  let choosePendingFile, releasePendingDecode;
  const conversation = { id: 'desktop-imports', revision: 1, completed: [], pending: null };
  let selected = null;
  const publish = (update = {}) => host.sendVoice({ state: 'idle', ready: true, operationId: null,
    selectedImage: selected, selectedImageId: selected?.id ?? null, conversation,
    capabilities: { text: { state: 'ready' }, recording: { state: 'ready' }, playback: { state: 'ready' } }, ...update });
  const commands = [];
  host.engine = { connected: true, async request(command) {
    commands.push(command);
    if (command.command === 'import-image') selected = command.image;
    if (command.command === 'select-image') selected = command.imageId ? selected : null;
    publish(); return { accepted: true, operationId: null };
  } };
  let selector;
  const selectorWindows = [];
  try {
    publish(); host.openPanel(); await wait(150);
    assert.equal(await evaluate('document.querySelector("#message").spellcheck'), true);
    const languages = panelWindow.webContents.session.getSpellCheckerLanguages();
    assert.ok(languages.includes('pl') && languages.includes('en-US'));
    const importControls = await evaluate(`['add-image', 'capture-screen'].map(id => {
      const button = document.getElementById(id), icon = button.querySelector('svg');
      const rect = button.getBoundingClientRect();
      const field = document.querySelector('#message').getBoundingClientRect();
      return { id, iconOnly: !!icon && !button.textContent.trim(),
        labelled: !!button.getAttribute('aria-label') && !!button.title,
        decorative: icon?.getAttribute('aria-hidden') === 'true',
        compact: rect.width === rect.height && rect.width <= 32,
        insideField: rect.left >= field.left && rect.right <= field.right && rect.top >= field.top && rect.bottom <= field.bottom,
        rightHalf: rect.left >= field.left + field.width / 2 };
    })`);
    assert.deepEqual(importControls, ['add-image', 'capture-screen'].map(id => ({
      id, iconOnly: true, labelled: true, decorative: true, compact: true, insideField: true, rightHalf: true,
    })), 'Image import actions use compact labelled icons inside the right side of the text field');
    const actionColumn = await evaluate(`(() => {
      const add = document.querySelector('#add-image').getBoundingClientRect();
      const capture = document.querySelector('#capture-screen').getBoundingClientRect();
      return { aligned: Math.abs(add.left - capture.left) <= 1,
        ordered: add.top < capture.top && add.bottom <= capture.top };
    })()`);
    assert.deepEqual(actionColumn, { aligned: true, ordered: true }, 'Image import actions form a vertical column');
    const multiline = await evaluate(`(() => {
      const input = document.querySelector('#message');
      const initialHeight = input.getBoundingClientRect().height;
      input.value = 'Pierwsza linia\\nDruga linia\\nTrzecia linia';
      input.dispatchEvent(new Event('input'));
      const field = input.getBoundingClientRect(), tools = document.querySelector('#composer-tools').getBoundingClientRect();
      return { grows: field.height > initialHeight,
        reserved: field.right - parseFloat(getComputedStyle(input).paddingRight) <= tools.left - 4,
        controlsInside: tools.top >= field.top && tools.bottom <= field.bottom && tools.right <= field.right };
    })()`);
    assert.deepEqual(multiline, { grows: true, reserved: true, controlsInside: true },
      'Multiline input grows while its text keeps clear of the actions on the right');
    await evaluate('document.querySelector("#message").value = "Zachowaj szkic"; document.querySelector("#message").dispatchEvent(new Event("input"))');
    if (!overlay.snapshot().pinned) overlay.togglePin();
    const formats = await evaluate(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 8;
      canvas.getContext('2d').fillRect(0, 0, 12, 8);
      return ['image/png', 'image/jpeg', 'image/webp'].map(mime => canvas.toDataURL(mime).split(',')[1]);
    })()`);
    for (const [index, extension] of ['png', 'jpg', 'webp'].entries()) {
      const filename = path.join(imageDirectory, `native-import.${extension}`);
      await fs.writeFile(filename, Buffer.from(formats[index], 'base64'));
      let decoding = false;
      if (index === 0) {
        const decodeGate = new Promise(resolve => { releasePendingDecode = resolve; });
        BrowserWindow.prototype.loadFile = function(filename, ...args) {
          if (path.basename(filename) === 'image-decoder.html') {
            decoding = true;
            return decodeGate.then(() => originalLoadFile.call(this, filename, ...args));
          }
          return originalLoadFile.call(this, filename, ...args);
        };
        dialog.showOpenDialog = () => new Promise(resolve => { choosePendingFile = resolve; });
      } else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      const count = commands.length;
      const beforeImport = overlay.snapshot();
      await evaluate('document.querySelector("#add-image").click()');
      if (index === 0) {
        await until(() => Boolean(choosePendingFile), 'File picker waits for a choice');
        await wait(100);
        assert.equal(panelWindow.isVisible(), true, 'Opening the file picker keeps the conversation visible');
        assert.deepEqual(overlay.snapshot(), beforeImport, 'File selection preserves popup mode and pin');
        assert.equal(await evaluate('document.querySelector("#message").value'), 'Zachowaj szkic');
        choosePendingFile({ canceled: false, filePaths: [filename] }); choosePendingFile = undefined;
        await until(() => decoding, 'Image decoder waits for native test release');
        await wait(100);
        assert.equal(panelWindow.isVisible(), true, 'Decoding a selected image keeps the conversation visible');
        assert.deepEqual(overlay.snapshot(), beforeImport);
        assert.equal(await evaluate('document.querySelector("#message").value'), 'Zachowaj szkic');
        releasePendingDecode(); releasePendingDecode = undefined;
        BrowserWindow.prototype.loadFile = originalLoadFile;
      }
      await until(() => commands.length > count, `${extension} import reaches worker`);
      await until(() => evaluate('!document.querySelector("#attachment-progress").checkVisibility()'), 'Import completes');
      const imported = nativeImage.createFromBuffer(await fs.readFile(path.join(imageDirectory, `${selected.id}.png`)));
      assert.deepEqual(imported.getSize(), { width: 12, height: 8 });
      assert.equal(await evaluate('document.querySelector("#message").value'), 'Zachowaj szkic');
      assert.equal(overlay.snapshot().pinned, true);
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'Hidden decoder is destroyed after import');
    }
    const beforeCancel = selected;
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    const cancelled = await evaluate('window.voiceDesktop.addImage("file")');
    assert.equal(cancelled.status, 'cancelled'); assert.equal(selected, beforeCancel);
    const reads = { count: 0 };
    clipboard.readImage = () => { reads.count++; return nativeImage.createFromBuffer(Buffer.from(formats[0], 'base64')); };
    const pastedText = await evaluate(`(() => {
      const data = new DataTransfer(); data.setData('text/plain', 'zwykły tekst');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector('#message').dispatchEvent(event); return event.defaultPrevented;
    })()`);
    assert.equal(pastedText, false); assert.equal(reads.count, 0, 'Ordinary paste retains native text behavior');
    await evaluate(`(() => {
      const data = new DataTransfer(); data.items.add(new File(['synthetic'], 'paste.png', { type: 'image/png' }));
      document.querySelector('#message').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    })()`);
    await until(() => reads.count === 1 && selected?.alt === 'Obraz ze schowka', 'Image paste reaches the native importer');
    await until(() => evaluate('!document.querySelector("#attachment-progress").checkVisibility()'), 'Paste completes');
    await until(() => evaluate('document.querySelector("#attachment-preview").naturalWidth === 12'), 'Attachment thumbnail loads');
    const removeControl = await evaluate(`(() => {
      const button = document.querySelector('#remove-attachment'), icon = button.querySelector('svg');
      const row = document.querySelector('#image-attachment').getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return { iconOnly: !!icon && !button.textContent.trim(),
        labelled: !!button.getAttribute('aria-label') && !!button.title,
        decorative: icon?.getAttribute('aria-hidden') === 'true',
        right: rect.left > row.left + row.width / 2 && rect.right <= row.right && row.right - rect.right <= 16 };
    })()`);
    assert.deepEqual(removeControl, { iconOnly: true, labelled: true, decorative: true, right: true },
      'The attachment can be removed with the labelled close icon on its right');
    await wait(100);
    await fs.writeFile(path.join(host.outputDirectory, 'electron-image-import.png'), (await panelWindow.webContents.capturePage()).toPNG());
    // Exercise actual selector windows against synthetic pixels, never the user's desktop.
    function SelectorWindow(options) { const window = new BrowserWindow(options); selectorWindows.push(window); return window; }
    selector = createScreenCapture({ BrowserWindow: SelectorWindow, ipcMain, screen, root: path.join(__dirname, '../../electron'),
      desktopCapturer: { async getSources() { return screen.getAllDisplays().map(display => ({ display_id: String(display.id),
        thumbnail: nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 120), { width: 800, height: 600 }) })); } } });
    host.screenCapture.capture = signal => selector.capture(signal);
    await evaluate('document.querySelector("#capture-screen").click()');
    await until(() => selectorWindows.length === screen.getAllDisplays().length && selectorWindows.every(window => window.isVisible()), 'Selectors become visible');
    assert.equal(panelWindow.isVisible(), false, 'Panel is absent from captured pixels');
    const window = selectorWindows.find(candidate => candidate.isFocused()) || selectorWindows[0];
    window.webContents.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 120, y: 100, button: 'left' });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: 120, y: 100, button: 'left', clickCount: 1 });
    await until(() => selected?.alt === 'Wycinek ekranu' && selectorWindows.every(candidate => candidate.isDestroyed()), 'Selected crop is attached and selectors close');
    await until(() => panelWindow.isVisible(), 'Panel returns after selection');
    assert.equal(overlay.snapshot().pinned, true);
    assert.equal(await evaluate('document.querySelector("#message").value'), 'Zachowaj szkic');
    const cropped = nativeImage.createFromBuffer(await fs.readFile(path.join(imageDirectory, `${selected.id}.png`)));
    assert.ok(cropped.getSize().width > 0 && cropped.getSize().width < 800);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    // Delayed admission after a new operation must not resurrect a consumed attachment.
    let acknowledge;
    host.engine = { connected: true, request: () => new Promise(resolve => { acknowledge = resolve; }) };
    await evaluate(`document.querySelector('#message').dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: (() => { const data = new DataTransfer(); data.items.add(new File(['x'], 'x.png', {type:'image/png'})); return data; })(), bubbles:true, cancelable:true }))`);
    await until(() => Boolean(acknowledge), 'Import waits for admission');
    selected = null; publish({ state: 'listening', operationId: 7 });
    acknowledge({ accepted: true, operationId: null });
    await until(() => evaluate('!document.querySelector("#attachment-progress").checkVisibility()'), 'Late admission completes');
    assert.equal(await evaluate('document.querySelector("#image-attachment").hidden'), true);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("main")).scrollbarWidth'), 'auto');
    console.log('Native clipboard, PNG/JPEG/WebP import and screen selector checks: passed');
  } finally {
    choosePendingFile?.({ canceled: true, filePaths: [] }); releasePendingDecode?.();
    BrowserWindow.prototype.loadFile = originalLoadFile;
    selector?.cancel();
    for (const window of selectorWindows) if (!window.isDestroyed()) window.destroy();
    dialog.showOpenDialog = originalPicker; clipboard.readImage = originalClipboard;
    host.screenCapture.capture = originalCapture; host.engine = originalEngine;
  }
}
module.exports = { verifyImageImports };
