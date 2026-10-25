const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, mkdir, utimes, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createImageImporter, MAX_IMAGE_BYTES } = require('../../electron/image-import.cjs');
const { parseDesktopRequest } = require('../../src/desktop-validation.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const id = createHash('sha256').update(png).digest('hex');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-image-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const imports = [], holds = [], holdOptions = [], focusRestores = [];
  const host = { imageDirectory: join(directory, 'images'), exitStarted: false,
    voice: { ready: true, state: 'idle', conversation: { id: 'one' }, operationId: null },
    engine: { connected: true, async request(command) { imports.push(command); return { accepted: true }; } },
    overlay: { hold(options) { holds.push('hold'); holdOptions.push(options); return focus => { holds.push('release'); focusRestores.push(focus); }; } },
    clipboard: { readImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }) },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) },
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    decode: async () => png,
    capture: { capture: async () => png },
  };
  return { directory, host, imports, holds, holdOptions, focusRestores, importer: createImageImporter(host) };
}

test('clipboard and screen images share canonical PNG storage and worker registration', async t => {
  const { host, importer, imports, holds, holdOptions } = await fixture(t);
  const clipboard = await importer.add('clipboard');
  assert.deepEqual(clipboard, { status: 'imported', image: { id, alt: 'Obraz ze schowka' } });
  assert.deepEqual(await readFile(join(host.imageDirectory, `${id}.png`)), png);
  const capture = await importer.add('screen');
  assert.equal(capture.status, 'imported');
  assert.deepEqual(imports.map(command => command.command), ['import-image', 'import-image']);
  assert.deepEqual(holds, ['hold', 'release', 'hold', 'release']);
  assert.deepEqual(holdOptions, [{ hide: false }, { hide: true }], 'Only screen capture hides the conversation');
});

test('native file selection alone supplies bytes and WebP is normalized by Chromium', async t => {
  const { directory, host, importer, imports, holdOptions } = await fixture(t);
  const source = Buffer.from('synthetic WebP source'), filename = join(directory, 'zdjęcie.webp');
  await writeFile(filename, source);
  host.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  host.decode = async (bytes, mime) => { assert.deepEqual(bytes, source); assert.equal(mime, 'image/webp'); return png; };
  assert.deepEqual(await importer.add('file'), { status: 'imported', image: { id, alt: 'zdjęcie.webp' } });
  assert.equal(imports.length, 1);
  assert.equal(JSON.stringify(imports).includes(directory), false, 'Worker receives only a descriptor, never the selected path');
  assert.deepEqual(holdOptions, [{ hide: false }], 'File selection and decoding keep the conversation visible');
});
test('reimporting an aged identical blob refreshes its age before worker registration', async t => {
  const { host, importer } = await fixture(t);
  await mkdir(host.imageDirectory, { recursive: true });
  const filename = join(host.imageDirectory, `${id}.png`);
  await writeFile(filename, png);
  await utimes(filename, new Date('2020-01-01'), new Date('2020-01-01'));
  host.engine.request = async () => {
    assert.ok((await stat(filename)).mtimeMs > Date.now() - 60000);
    return { accepted: true };
  };
  assert.equal((await importer.add('clipboard')).status, 'imported');
});

test('cancelled picker, empty clipboard and corrupt images never replace the attachment', async t => {
  const { host, importer, imports, holds } = await fixture(t);
  assert.deepEqual(await importer.add('file'), { status: 'cancelled' });
  host.clipboard.readImage = () => ({ isEmpty: () => true });
  assert.equal((await importer.add('clipboard')).status, 'error');
  host.capture.capture = async () => Buffer.from('not a PNG');
  assert.equal((await importer.add('screen')).status, 'error');
  assert.deepEqual(imports, []);
  assert.equal(holds.filter(value => value === 'hold').length, holds.filter(value => value === 'release').length);
});

test('oversized files are rejected before decode and unsupported documents stay out', async t => {
  const { directory, host, importer, imports } = await fixture(t);
  const file = join(directory, 'big.png');
  await writeFile(file, Buffer.alloc(MAX_IMAGE_BYTES + 1));
  host.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  host.decode = async () => { throw new Error('Decoder must not run'); };
  assert.match((await importer.add('file')).message, /32 MiB/);
  host.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(directory, 'note.pdf')] });
  assert.match((await importer.add('file')).message, /PNG, JPEG lub WebP/);
  assert.deepEqual(imports, []);
});

test('conversation changes abort an in-flight import and ignore late results', async t => {
  const { host, importer, imports } = await fixture(t);
  let complete;
  host.capture.capture = () => new Promise(resolve => { complete = resolve; });
  const pending = importer.add('screen');
  host.voice.conversation.id = 'two'; importer.stateChanged();
  complete(png);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.deepEqual(imports, []);
});

test('overlapping requests and foreign IPC source values are rejected', async t => {
  const { host, importer } = await fixture(t);
  let complete;
  host.capture.capture = () => new Promise(resolve => { complete = resolve; });
  const pending = importer.add('screen');
  assert.equal((await importer.add('clipboard')).status, 'error');
  complete(null); await pending;
  for (const value of ['pdf', null, { path: 'private.png' }, 42]) assert.equal(parseDesktopRequest('voice:image-import', value), null);
  assert.deepEqual(parseDesktopRequest('voice:image-import', 'clipboard'), { channel: 'voice:image-import', value: 'clipboard' });
});
test('a late worker acknowledgement cannot resurrect an image consumed by another operation', async t => {
  const { host, importer, focusRestores } = await fixture(t);
  let acknowledge;
  host.engine.request = () => new Promise(resolve => { acknowledge = resolve; });
  const pending = importer.add('clipboard');
  for (let i = 0; i < 100 && !acknowledge; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(acknowledge);
  host.voice.operationId = 2; host.voice.state = 'listening'; importer.stateChanged();
  acknowledge({ accepted: true });
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.deepEqual(focusRestores, [false], 'A cancelled import cannot steal focus from a new voice operation');
});
