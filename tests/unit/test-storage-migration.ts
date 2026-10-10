import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppStorage } from '../../src/app-storage.ts';
import { ConversationRepository } from '../../src/conversation-repository.ts';
import { UnsupportedStorageVersion } from '../../src/conversation-format.ts';
import { currentId, previousId, legacyMetadata, legacyCurrent, legacyPrevious } from '../helpers/storage-v1.ts';

async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'voice-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
for (const mode of ['local', 'imagegen'] as const) test(`${mode} migration preserves bytes, IDs, images and undo across restart`, async t => {
  t.mock.method(Date, 'now', () => 1000000);
  const root = await directory(t), home = join(root, `${mode}-codex`);
  fs.mkdirSync(home);
  const fixtures = [['session.json', legacyMetadata], [`${currentId}.json`, legacyCurrent], [`${previousId}.json`, legacyPrevious]];
  fixtures.forEach(([file, contents]) => fs.writeFileSync(join(home, file), contents));
  const storage = createAppStorage(mode, root);
  for (const [file, original] of fixtures) {
    assert.equal(JSON.parse(fs.readFileSync(join(home, file), 'utf8')).version, 2);
    const backup = fs.readdirSync(home).find(name => name.startsWith(`${file}.legacy-`))!;
    assert.equal(fs.readFileSync(join(home, backup), 'utf8'), original);
  }
  const current = storage.session.currentExchanges;
  assert.equal(current.length, 2);
  assert.equal(current[1].images![0].id, 'a'.repeat(64));
  assert.equal(current[1].imageTask!.turnId, 'turn_image');
  assert.ok(current.every(exchange => exchange.id && exchange.revision === 1));
  const files = fs.readdirSync(home);
  const restarted = createAppStorage(mode, root);
  assert.deepEqual(restarted.session.currentExchanges, current);
  assert.deepEqual(fs.readdirSync(home), files, 'v2 restart does not create more migration backups');
  assert.equal(restarted.session.restorePrevious(), true);
  assert.equal(restarted.session.threadId, previousId);
  assert.equal(restarted.session.currentExchanges[0].answer, 'Poprzednia odpowiedź');
  const restored = createAppStorage(mode, root);
  assert.equal(restored.session.restorePrevious(), true);
  assert.deepEqual(restored.session.currentExchanges, current);
});

for (const mode of ['local', 'imagegen', 'realtime'] as const) test(`${mode} retry is idempotent before and after restart and rejects ID conflicts`, async t => {
  const root = await directory(t), storage = createAppStorage(mode, root);
  storage.session.threadId = currentId;
  const reply = { exchangeId: 'operation_1', prompt: 'Q', answer: 'A' };
  await Promise.all([storage.commitReply(reply), storage.commitReply(reply)]);
  assert.equal(storage.session.currentExchanges.length, 1);
  const metadata = join(storage.home, 'session.json'), index = join(storage.home, 'history-index.json');
  const before = [metadata, index].map(file => fs.readFileSync(file, 'utf8'));
  const restarted = createAppStorage(mode, root);
  await restarted.commitReply(reply);
  assert.deepEqual(restarted.session.currentExchanges, storage.session.currentExchanges);
  assert.deepEqual([metadata, index].map(file => fs.readFileSync(file, 'utf8')), before);
  await assert.rejects(restarted.commitReply({ ...reply, answer: 'different' }), /Conflicting conversation exchange ID/);
  assert.deepEqual([metadata, index].map(file => fs.readFileSync(file, 'utf8')), before);
});

test('failed migration write retains legacy bytes and propagates a filesystem failure, then restart migrates', async t => {
  const root = await directory(t), metadata = join(root, 'session.json'), history = join(root, `${currentId}.json`);
  fs.writeFileSync(metadata, legacyMetadata); fs.writeFileSync(history, legacyCurrent);
  let fail = true;
  const repository = new ConversationRepository(metadata, { ...fs, renameSync(from, to) {
    if (to === history && fail) { fail = false; throw Object.assign(new Error('migration denied'), { code: 'EACCES' }); }
    fs.renameSync(from, to);
  } }, root, { versioned: true });
  repository.load();
  assert.throws(() => repository.loadHistory(currentId), /migration denied/);
  assert.equal(fs.readFileSync(history, 'utf8'), legacyCurrent);
  const backup = fs.readdirSync(root).find(name => name.startsWith(`${currentId}.json.legacy-`))!;
  assert.equal(fs.readFileSync(join(root, backup), 'utf8'), legacyCurrent);
  const recovered = new ConversationRepository(metadata, undefined, root, { versioned: true }).loadHistory(currentId);
  assert.equal(recovered.status, 'loaded');
  assert.equal(JSON.parse(fs.readFileSync(history, 'utf8')).version, 2);
});

test('unknown metadata and history versions remain untouched', async t => {
  const root = await directory(t), home = join(root, 'local-codex');
  fs.mkdirSync(home);
  const metadata = join(home, 'session.json'), future = '{"version":99}';
  fs.writeFileSync(metadata, future);
  assert.throws(() => createAppStorage('local', root), UnsupportedStorageVersion);
  assert.equal(fs.readFileSync(metadata, 'utf8'), future);
  assert.deepEqual(fs.readdirSync(home), ['session.json']);
  fs.writeFileSync(metadata, legacyMetadata); fs.writeFileSync(join(home, `${currentId}.json`), future);
  assert.throws(() => createAppStorage('local', root), UnsupportedStorageVersion);
  assert.equal(fs.readFileSync(join(home, `${currentId}.json`), 'utf8'), future);
  assert.equal(fs.readdirSync(home).some(name => name.startsWith(`${currentId}.json.`)), false);
});
