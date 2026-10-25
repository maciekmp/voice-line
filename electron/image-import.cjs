const { readFile, stat, mkdir } = require('node:fs/promises');
const { extname, basename, join } = require('node:path');
const { createHash } = require('node:crypto');
const { writeAtomic } = require('./atomic-file.cjs');

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function validatePng(bytes, nativeImage) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG)) {
    throw new Error('Obraz PNG może mieć maksymalnie 32 MiB.');
  }
  if (bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > MAX_IMAGE_PIXELS) throw new Error('Obraz ma zbyt dużą rozdzielczość.');
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error('Nie można odczytać obrazu lub ma on zbyt dużą rozdzielczość.');
  }
}

async function storeImportedPng(directory, bytes, alt, nativeImage) {
  validatePng(bytes, nativeImage);
  const id = createHash('sha256').update(bytes).digest('hex');
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `${id}.png`);
  // Refresh the blob's age before worker registration: an identical old orphan
  // must not remain eligible for retention cleanup while its new lease arrives.
  await writeAtomic(filename, bytes);
  return { id, alt: alt.slice(0, 2000) };
}

// Only native-selected bytes enter the decoder. The panel receives a descriptor,
// never an arbitrary filesystem path or the ability to import one.
function createImageImporter(host) {
  let active;
  function available() {
    return !host.exitStarted && host.engine?.connected && host.voice.ready && ['idle', 'error'].includes(host.voice.state);
  }
  function current(job) {
    return active === job && !job.abort.signal.aborted && available() && job.engine === host.engine
      && job.conversation === (host.voice.conversation?.id ?? host.voice.threadId ?? null)
      && job.operation === (host.voice.operationId ?? null);
  }
  function cancel() { active?.abort.abort(); }
  return {
    stateChanged() { if (active && !current(active)) cancel(); },
    cancel,
    async add(source) {
      if (active || !available()) return { status: 'error', message: 'Poczekaj na gotowość aplikacji i zakończenie odpowiedzi.' };
      const job = { engine: host.engine, conversation: host.voice.conversation?.id ?? host.voice.threadId ?? null,
        operation: host.voice.operationId ?? null, focused: host.panelWindow?.isFocused?.() ?? true, abort: new AbortController() };
      active = job;
      const release = host.overlay.hold({ hide: source === 'screen' });
      try {
        let bytes, alt;
        if (source === 'file') {
          const choice = await host.dialog.showOpenDialog(host.panelWindow, { title: 'Dodaj obraz',
            properties: ['openFile'], filters: [{ name: 'Obrazy PNG, JPEG i WebP', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
          if (choice.canceled || !choice.filePaths?.[0] || !current(job)) return { status: 'cancelled' };
          const filename = choice.filePaths[0], mime = mimeTypes[extname(filename).toLowerCase()];
          if (!mime) throw new Error('Wybierz obraz PNG, JPEG lub WebP.');
          const info = await stat(filename);
          if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('Plik obrazu może mieć maksymalnie 32 MiB.');
          const input = await readFile(filename);
          if (input.length > MAX_IMAGE_BYTES) throw new Error('Plik obrazu może mieć maksymalnie 32 MiB.');
          if (!current(job)) return { status: 'cancelled' };
          bytes = await host.decode(input, mime, job.abort.signal);
          alt = basename(filename);
        } else if (source === 'clipboard') {
          const image = host.clipboard.readImage();
          if (image.isEmpty()) throw new Error('Schowek nie zawiera obrazu.');
          const size = image.getSize();
          if (size.width * size.height > MAX_IMAGE_PIXELS) throw new Error('Obraz ze schowka ma zbyt dużą rozdzielczość.');
          bytes = image.toPNG(); alt = 'Obraz ze schowka';
        } else if (source === 'screen') {
          bytes = await host.capture.capture(job.abort.signal); alt = 'Wycinek ekranu';
          if (!bytes) return { status: 'cancelled' };
        } else throw new Error('Nieznane źródło obrazu.');
        if (!current(job)) return { status: 'cancelled' };
        const image = await storeImportedPng(host.imageDirectory, bytes, alt, host.nativeImage);
        if (!current(job)) return { status: 'cancelled' };
        const result = await job.engine.request({ command: 'import-image', image });
        if (!current(job)) return { status: 'cancelled' };
        if (!result.accepted) throw new Error('Nie dodano obrazu. Poczekaj na zakończenie odpowiedzi i spróbuj ponownie.');
        return { status: 'imported', image };
      } catch (error) {
        if (job.abort.signal.aborted || error.name === 'AbortError') return { status: 'cancelled' };
        return { status: 'error', message: error.message || 'Nie udało się dodać obrazu.' };
      } finally {
        const restoreFocus = current(job) && job.focused;
        if (active === job) active = undefined;
        release(restoreFocus);
      }
    },
  };
}

module.exports = { createImageImporter, storeImportedPng, validatePng, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS };
