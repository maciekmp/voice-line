import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';

test('corrupt neighbouring index defers cleanup, preserves shared data, then retries after repair', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000;
  const retention = new ConversationRetention(join(root, 'local-codex'), root, () => now);
  const id = '11111111-1111-1111-1111-111111111111', image = 'a'.repeat(64);
  retention.touch(id, [{ id: image, alt: 'image' }]); now += HISTORY_TTL_MS;
  const foreign = join(root, 'imagegen-codex', 'history-index.json');
  await mkdir(join(root, 'imagegen-codex'));
  await mkdir(join(root, 'images')); await writeFile(join(root, 'images', `${image}.png`), 'pixels');
  await writeFile(foreign, '[null]');
  let deletions = 0;
  assert.deepEqual(await retention.prune(async () => { deletions++; }), []);
  assert.equal(deletions, 0);
  assert.equal(retention.cleanupHealth.state, 'deferred');
  assert.equal(retention.cleanupHealth.issues[0].file, foreign);
  await access(join(root, 'images', `${image}.png`));
  // Healthy active storage can continue recording activity.
  retention.touch('22222222-2222-2222-2222-222222222222');
  await writeFile(foreign, '{}');
  assert.deepEqual(await retention.prune(async () => { deletions++; }), [id]);
  assert.equal(deletions, 1);
  assert.equal(retention.cleanupHealth.state, 'healthy');
  await assert.rejects(access(join(root, 'images', `${image}.png`)));
});
