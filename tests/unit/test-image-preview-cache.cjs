const { test } = require('node:test');
const assert = require('node:assert/strict');

test('preview cache deduplicates in-flight requests and evicts least recently used entries', async () => {
  const { createImagePreviewCache } = await import('../../electron/image-preview-cache.js');
  const calls = [];
  const cache = createImagePreviewCache({ load: async id => { calls.push(id); return `data:image/png;base64,${id}`; }, maxEntries: 2 });
  const first = cache.get('a');
  assert.equal(cache.get('a'), first);
  await first;
  await cache.get('b'); await cache.get('a'); await cache.get('c'); await cache.get('a');
  assert.deepEqual(calls, ['a', 'b', 'c']);
  await cache.get('b');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
  assert.equal(cache.stats.entries, 2);
  assert.equal(cache.stats.pending, 0);
  const before = cache.stats.bytes;
  cache.invalidate('b');
  assert.ok(cache.stats.bytes < before);
  await cache.get('b');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b', 'b']);
});

test('preview cache enforces the byte limit and does not retain oversized PNG payloads', async () => {
  const { createImagePreviewCache } = await import('../../electron/image-preview-cache.js');
  const cache = createImagePreviewCache({ load: async id => `data:image/png;base64,${id.repeat(id === 'large' ? 100 : 1)}`, maxBytes: 100 });
  await cache.get('a'); await cache.get('b'); await cache.get('c');
  assert.equal(cache.stats.entries, 2);
  assert.ok(cache.stats.bytes <= 100);
  const before = cache.stats.requests;
  await cache.get('large'); await cache.get('large');
  assert.equal(cache.stats.requests, before + 2);
  assert.equal(cache.stats.entries, 2);
  assert.ok(cache.stats.bytes <= 100);
});

test('failed or unavailable previews can be retried and invalid limits are rejected', async () => {
  const { createImagePreviewCache } = await import('../../electron/image-preview-cache.js');
  let attempt = 0;
  const cache = createImagePreviewCache({ load: async () => {
    attempt++; if (attempt === 1) throw new Error('temporary read error');
    return attempt === 2 ? null : 'data:image/png;base64,AA==';
  } });
  await assert.rejects(cache.get('a'), /temporary/);
  assert.equal(cache.stats.pending, 0);
  assert.equal(await cache.get('a'), null);
  assert.equal(await cache.get('a'), 'data:image/png;base64,AA==');
  assert.equal(attempt, 3);
  for (const options of [{ maxEntries: 0 }, { maxEntries: 1.5 }, { maxBytes: Infinity }, { maxBytes: -1 }]) {
    assert.throws(() => createImagePreviewCache({ load: async () => null, ...options }), /limits/);
  }
});
