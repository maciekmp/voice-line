import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyImportedImage } from '../../src/imported-image.ts';

test('worker accepts only the verified content-addressed imported PNG', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-image-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'images'));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const image = { id: createHash('sha256').update(bytes).digest('hex'), alt: 'test' };
  await writeFile(join(directory, 'images', `${image.id}.png`), bytes);
  assert.deepEqual(verifyImportedImage(directory, image), image);
  assert.throws(() => verifyImportedImage(directory, { ...image, id: '../outside' }));
  await writeFile(join(directory, 'images', `${image.id}.png`), bytes.subarray(0, 20));
  assert.throws(() => verifyImportedImage(directory, image));
  await writeFile(join(directory, 'images', `${image.id}.png`), Buffer.concat([bytes, Buffer.from('changed')]));
  assert.throws(() => verifyImportedImage(directory, image));
});
