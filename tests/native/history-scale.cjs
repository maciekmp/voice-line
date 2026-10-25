const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function verifyHistoryScale({ panelWindow, outputDirectory, imageId }) {
  const historyUrl = pathToFileURL(path.resolve(__dirname, '../../electron/history-renderer.js')).href;
  const baselineUrl = pathToFileURL(path.resolve(__dirname, '../helpers/history-baseline.js')).href;
  const imagesUrl = pathToFileURL(path.resolve(__dirname, '../../electron/image-renderer.js')).href;
  const measurements = await panelWindow.webContents.executeJavaScript(String.raw`(async () => {
    const { createHistoryRenderer } = await import(${JSON.stringify(historyUrl)});
    const { createBaselineHistoryRenderer } = await import(${JSON.stringify(baselineUrl)});
    const results = [];
    const exchange = i => ({ id: 'scale-' + i, revision: 1, question: 'Pytanie ' + i,
      answer: 'Odpowiedź zawierająca tekst. '.repeat(8) + '\n\n\u0060\u0060\u0060text\n' + 'code '.repeat(50) + '\n\u0060\u0060\u0060' });
    for (const count of [100, 1000, 3000]) {
      for (const [name, factory] of [['baseline', createBaselineHistoryRenderer], ['incremental', createHistoryRenderer]]) {
        const container = document.createElement('section');
        container.style.cssText = 'position:fixed;left:-10000px;top:0;width:380px';
        document.body.append(container);
        const renderer = factory(container);
        let history = Array.from({ length: count }, (_, i) => exchange(i));
        let started = performance.now(); renderer.update(history, { conversationId: 'scale', revision: 1 });
        const initialMs = performance.now() - started;
        const first = container.firstElementChild;
        const button = first.querySelector('button'); button.dataset.copied = 'true'; button.focus({ preventScroll: true });
        let phaseMs = 0;
        for (let i = 0; i < 20; i++) {
          const copied = history.map(item => ({ ...item }));
          started = performance.now(); renderer.update(copied, { conversationId: 'scale', revision: 1 });
          phaseMs += performance.now() - started;
        }
        let appendMs = 0;
        for (let i = 0; i < 3; i++) {
          history = [...history, exchange(count + i)];
          started = performance.now(); renderer.update(history, { conversationId: 'scale', revision: i + 2 });
          appendMs += performance.now() - started;
        }
        results.push({ name, count, initialMs, phase20Ms: phaseMs, append3Ms: appendMs,
          retainedFirst: container.firstElementChild === first,
          retainedCopy: container.firstElementChild.querySelector('button').dataset.copied === 'true',
          retainedFocus: document.activeElement === button, rows: container.children.length,
          stats: renderer.stats || null });
        renderer.dispose?.(); container.remove();
      }
    }
    const identityContainer = document.createElement('section'); document.body.append(identityContainer);
    const selectedInputs = [];
    const identityRenderer = createHistoryRenderer(identityContainer, { onSelect: image => selectedInputs.push(image.id) });
    const one = exchange(1), two = exchange(2), three = exchange(3);
    identityRenderer.update([one, two, three], { conversationId: 'identity', revision: 1 });
    const firstNode = identityContainer.firstElementChild;
    identityRenderer.update([{ ...one, revision: 2, answer: 'Zmiana odpowiedzi' }, three], { conversationId: 'identity', revision: 2 });
    const revised = identityContainer.firstElementChild === firstNode && firstNode.querySelector('.previous-answer').textContent === 'Zmiana odpowiedzi';
    const pruned = identityContainer.children.length === 2 && identityRenderer.stats.rows === 2;
    identityRenderer.update([three, { ...one, revision: 2, answer: 'Zmiana odpowiedzi' }], { conversationId: 'identity', revision: 3 });
    const reordered = identityContainer.lastElementChild === firstNode;
    identityRenderer.update([one], { conversationId: 'other', revision: 1 });
    const switched = identityContainer.firstElementChild !== firstNode && identityRenderer.stats.rows === 1;
    identityRenderer.update([], { conversationId: null, revision: 2 });
    const cleared = identityContainer.childElementCount === 0 && identityRenderer.stats.rows === 0;
    const attached = { id: 'attached', revision: 1, question: 'Pytanie o obraz', answer: 'Opis obrazu',
      inputImages: [{ id: ${JSON.stringify(imageId)}, alt: 'Załączony obraz' }],
      images: [{ id: ${JSON.stringify(imageId)}, alt: 'Wynik generowania' }] };
    identityRenderer.update([attached], { conversationId: 'inputs', revision: 1 });
    const inputRow = identityContainer.firstElementChild;
    const inputButton = inputRow.querySelector('.input-image-thumbnail');
    inputButton.click();
    const inputAttachment = inputButton.dataset.imageId === ${JSON.stringify(imageId)}
      && selectedInputs[0] === ${JSON.stringify(imageId)}
      && inputRow.children[1].classList.contains('input-attachments')
      && inputRow.children[2].classList.contains('previous-answer')
      && inputRow.querySelectorAll('.message-attachments .image-stage').length === 1;
    identityRenderer.update([{ ...attached, revision: 2, inputImages: [{ ...attached.inputImages[0], alt: 'Zmieniony podpis' }] }],
      { conversationId: 'inputs', revision: 2 });
    const inputRevision = identityContainer.firstElementChild === inputRow
      && inputRow.querySelector('.input-image-thumbnail').getAttribute('aria-label').includes('Zmieniony podpis');
    identityRenderer.dispose(); identityContainer.remove();
    const { renderImages, imagePreviewCache } = await import(${JSON.stringify(imagesUrl)});
    const container = document.createElement('section'); container.hidden = true;
    container.style.cssText = 'position:fixed;top:10px;left:10px;width:200px';
    document.body.append(container);
    const before = imagePreviewCache.stats;
    const dispose = renderImages(container, [{ id: ${JSON.stringify(imageId)}, alt: 'Lazy preview test' }], { lazy: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    const hidden = imagePreviewCache.stats;
    container.hidden = false;
    for (let i = 0; i < 100 && !container.querySelector('img').naturalWidth; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const visible = imagePreviewCache.stats;
    const loaded = container.querySelector('img').naturalWidth;
    container.hidden = true;
    await new Promise(resolve => setTimeout(resolve, 100));
    const released = !container.querySelector('img').hasAttribute('src');
    dispose(); container.remove();
    return { results, identity: { revised, pruned, reordered, switched, cleared, inputAttachment, inputRevision },
      lazyImages: { before, hidden, visible, loaded, released }, viewport: { width: innerWidth, height: innerHeight } };
  })().catch(error => ({ error: { message: error.message, stack: error.stack } }))`);
  if (measurements.error) throw new Error(`${measurements.error.message}\n${measurements.error.stack}`);
  for (const result of measurements.results.filter(item => item.name === 'incremental')) {
    assert.equal(result.rows, result.count + 3);
    assert.equal(result.stats.created, result.count + 3, 'Append creates only the added rows');
    assert.equal(result.stats.updated, 0, 'Phase updates do not rewrite committed exchanges');
    assert.equal(result.retainedFirst, true); assert.equal(result.retainedCopy, true); assert.equal(result.retainedFocus, true);
  }
  const lazy = measurements.lazyImages;
  for (const [name, passed] of Object.entries(measurements.identity)) assert.equal(passed, true, name);
  assert.equal(lazy.hidden.requests, lazy.before.requests, 'Hidden history must not request a PNG');
  assert.equal(lazy.hidden.hits, lazy.before.hits, 'Hidden history must not even read the preview cache');
  assert.equal(lazy.loaded, 256, 'Visible history loads the production PNG preview');
  assert.equal(lazy.released, true, 'Offscreen DOM releases the base64 payload');
  assert.ok(lazy.visible.bytes <= lazy.visible.maxBytes && lazy.visible.entries <= lazy.visible.maxEntries);
  const report = { timestamp: new Date().toISOString(), electron: process.versions.electron, chromium: process.versions.chrome,
    scope: 'Synchronous DOM renderer only, without IPC/filesystem/audio cost. Initial render, 20 unchanged phase snapshots, 3 appends. Captured pre-refactor history algorithm versus production incremental renderer. Timings are observations, not gates.',
    ...measurements };
  await fs.writeFile(path.join(outputDirectory, 'history-scale.json'), JSON.stringify(report, null, 2));
  console.log('Incremental history, lazy preview and scale checks: passed');
}
module.exports = { verifyHistoryScale };
