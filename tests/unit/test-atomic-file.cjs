const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { writeAtomic } = require('../../electron/atomic-file.cjs');

for (const phase of ['write', 'rename', 'success']) test(`atomic export: ${phase} preserves destination and removes temporary file`, async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'voice-export-')), filename = join(root, 'saved.md');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(filename, 'previous export');
  const filesystem = { ...fs,
    async writeFile(file, contents, options) {
      if (phase === 'write') { await fs.writeFile(file, 'partial', options); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
      return fs.writeFile(file, contents, options);
    },
    async rename(from, to) {
      if (phase === 'rename') throw Object.assign(new Error('rename denied'), { code: 'EACCES' });
      return fs.rename(from, to);
    },
  };
  const writing = writeAtomic(filename, 'new export', filesystem);
  if (phase === 'success') await writing;
  else await assert.rejects(writing, /disk full|rename denied/);
  assert.equal(await fs.readFile(filename, 'utf8'), phase === 'success' ? 'new export' : 'previous export');
  assert.deepEqual(await fs.readdir(root), ['saved.md']);
});

test('concurrent exports use separate temporary files and write complete contents', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'voice-export-')), filename = join(root, 'saved.png');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = Buffer.alloc(10000, 1), second = Buffer.alloc(10000, 2);
  await Promise.all([writeAtomic(filename, first), writeAtomic(filename, second)]);
  const actual = await fs.readFile(filename);
  assert.ok(actual.equals(first) || actual.equals(second));
  assert.deepEqual(await fs.readdir(root), ['saved.png']);
});
