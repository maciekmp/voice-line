import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationRepository } from '../../src/conversation-repository.ts';
import { ConversationSession } from '../../src/conversation-session.ts';
import { createAppStorage } from '../../src/app-storage.ts';

for (const phase of ['history', 'index', 'links', 'metadata'] as const) test(`full transaction rolls back after ${phase} write fails`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-full-commit-')), home = join(root, 'local-codex');
  t.after(() => rm(root, { recursive: true, force: true }));
  fs.mkdirSync(home); fs.mkdirSync(join(root, 'image-links'));
  const metadata = join(home, 'session.json'), index = join(home, 'history-index.json'), links = join(root, 'image-links', `${id}.json`);
  const history = join(home, `${id}.json`), paths = { metadata, index, links, history };
  let fail = false;
  const repository = new ConversationRepository(metadata, { ...fs, renameSync(from, to) {
    if (fail && to === paths[phase]) { fail = false; throw new Error('transaction failed'); }
    fs.renameSync(from, to);
  } }, root);
  const session = new ConversationSession(home, () => 1000, 'session.json', { localHistory: true, durablePrevious: true, repository });
  session.threadId = id;
  session.answered({ prompt: 'Q', answer: 'A' }, [{ file: index, contents: 'old-index' }, { file: links, contents: 'old-links' }]);
  const before = Object.values(paths).map(file => fs.readFileSync(file, 'utf8'));
  const revision = session.revision;
  fail = true;
  assert.throws(() => session.answered({ prompt: 'unfinished', answer: 'unfinished' },
    [{ file: index, contents: 'new-index' }, { file: links, contents: 'new-links' }]), /transaction failed/);
  assert.deepEqual(Object.values(paths).map(file => fs.readFileSync(file, 'utf8')), before);
  assert.equal(session.revision, revision);
  assert.equal(session.currentExchanges.length, 1);
});

for (let interruptedAfter = 1; interruptedAfter <= 4; interruptedAfter++) test(`restart recovers all transaction files after ${interruptedAfter} replacements`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-full-crash-')), home = join(root, 'local-codex');
  t.after(() => rm(root, { recursive: true, force: true }));
  fs.mkdirSync(home); fs.mkdirSync(join(root, 'image-links'));
  const metadata = join(home, 'session.json');
  const files = [join(home, `${id}.json`), join(home, 'history-index.json'), join(root, 'image-links', `${id}.json`), metadata];
  const old = files.map((file, i) => ({ file: relative(root, file), contents: i === 2 ? null : `old-${i}` }));
  old.forEach(entry => { if (entry.contents !== null) fs.writeFileSync(join(root, entry.file), entry.contents); });
  fs.writeFileSync(`${metadata}.commit.json`, JSON.stringify({ version: 2, files: old }));
  files.slice(0, interruptedAfter).forEach(file => fs.writeFileSync(file, 'unfinished'));
  new ConversationRepository(metadata, undefined, root);
  old.forEach(entry => assert.equal(fs.existsSync(join(root, entry.file)) ? fs.readFileSync(join(root, entry.file), 'utf8') : null, entry.contents));
  assert.equal(fs.existsSync(`${metadata}.commit.json`), false);
});

test('queued exchange is rejected when reset changes the selected conversation before commit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-stale-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAppStorage('local', root);
  storage.session.threadId = id;
  const pending = storage.commitReply({ prompt: 'stale', answer: 'stale' });
  storage.session.reset();
  await assert.rejects(pending, /changed before commit/);
  assert.equal(storage.session.threadId, null);
  assert.equal(fs.existsSync(join(root, 'local-codex', `${id}.json`)), false);
  assert.equal(storage.retention.hasRecords, false);
});

test('repository rejects journal paths outside the data root before recovery mutates files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-invalid-journal-')), metadata = join(root, 'session.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  fs.writeFileSync(metadata, 'keep');
  fs.writeFileSync(`${metadata}.commit.json`, JSON.stringify({ version: 2, files: [{ file: '../outside.json', contents: 'invalid' }, { file: 'session.json', contents: 'old' }] }));
  assert.throws(() => new ConversationRepository(metadata), /Invalid conversation transaction path/);
  assert.equal(fs.readFileSync(metadata, 'utf8'), 'keep');
});

test('production storage commits link and index with the answer, invalid link changes neither', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-production-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAppStorage('local', root);
  storage.session.threadId = id;
  const task = { threadId: '22222222-2222-2222-2222-222222222222', turnId: 'turn_1' };
  await storage.commitReply({ prompt: 'Q', answer: 'A', imageTask: task }, { ...task, anchor: 0 });
  assert.deepEqual(await storage.artifacts.readLinks(id), [{ ...task, anchor: 0 }]);
  const indexFile = join(storage.home, 'history-index.json');
  const index = fs.readFileSync(indexFile, 'utf8');
  assert.deepEqual(JSON.parse(index)[id].tasks, [task.threadId]);
  const metadata = fs.readFileSync(join(storage.home, 'session.json'), 'utf8');
  await assert.rejects(storage.commitReply({ prompt: 'bad', answer: 'bad' }, { ...task, anchor: -1 }), /Invalid image history link/);
  assert.equal(storage.session.currentExchanges.length, 1);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), index);
  assert.equal(fs.readFileSync(join(storage.home, 'session.json'), 'utf8'), metadata);
});

test('cancellation while commit is queued leaves history and retention unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-cancel-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAppStorage('local', root);
  storage.session.threadId = id;
  let cancelled = false;
  const pending = storage.commitReply({ prompt: 'cancelled', answer: 'cancelled' }, undefined, () => !cancelled);
  cancelled = true;
  await assert.rejects(pending, /Cancelled/);
  assert.equal(storage.session.currentExchanges.length, 0);
  assert.equal(storage.retention.hasRecords, false);
});

test('legacy history import commits all shared image and task references with the cached history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'realtime-codex'); fs.mkdirSync(home);
  fs.writeFileSync(join(home, 'session.json'), JSON.stringify({ threadId: id, lastAnswerAt: Date.now() }));
  const storage = createAppStorage('realtime', root);
  const history = [
    { question: 'Q1', answer: 'A1', images: [{ id: 'a'.repeat(64), alt: 'first' }], inputImages: [{ id: 'c'.repeat(64), alt: 'attached' }], imageTask: { threadId: id, turnId: 'turn_1' } },
    { question: 'Q2', answer: 'A2', images: [{ id: 'b'.repeat(64), alt: 'second' }], imageTask: { threadId: '22222222-2222-2222-2222-222222222222', turnId: 'turn_2' } },
  ];
  const imported = await storage.importHistory(id, history);
  const index = JSON.parse(fs.readFileSync(join(home, 'history-index.json'), 'utf8'))[id];
  assert.deepEqual(index.images, ['a'.repeat(64), 'c'.repeat(64), 'b'.repeat(64)]);
  assert.deepEqual(index.tasks, history.map(exchange => exchange.imageTask.threadId));
  assert.ok(imported.every(exchange => exchange.id));
  assert.deepEqual(createAppStorage('realtime', root).session.currentExchanges, imported);
  assert.deepEqual(await storage.importHistory(id, [{ question: 'remote cancelled', answer: 'remote cancelled' }]), imported);
});

test('failed restore index preparation leaves session and metadata at the previous snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-restore-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createAppStorage('realtime', root);
  storage.session.threadId = id;
  await storage.commitReply({ prompt: 'Q', answer: 'A' }); storage.session.reset();
  const metadata = join(storage.home, 'session.json'), before = fs.readFileSync(metadata, 'utf8');
  fs.writeFileSync(join(storage.home, 'history-index.json'), '[null]');
  await assert.rejects(storage.restorePrevious(), /Invalid application history index/);
  assert.equal(storage.session.threadId, null);
  assert.equal(storage.session.previousConversationId, id);
  assert.equal(fs.readFileSync(metadata, 'utf8'), before);
  fs.writeFileSync(join(storage.home, 'history-index.json'), '{}');
  assert.equal(await storage.restorePrevious(), true);
  assert.equal(storage.session.threadId, id);
  assert.ok(JSON.parse(fs.readFileSync(join(storage.home, 'history-index.json'), 'utf8'))[id]);
});

const id = '11111111-1111-1111-1111-111111111111';
for (const phase of ['history', 'metadata', 'commit'] as const) test(`failed ${phase} commit keeps memory and disk at previous snapshot`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-commit-')), metadata = join(root, 'session.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  let failing = false, now = 1000;
  const repository = new ConversationRepository(metadata, { ...fs,
    renameSync(from, to) {
      if (failing && ((phase === 'history' && to === join(root, `${id}.json`)) || (phase === 'metadata' && to === metadata))) {
        failing = false; throw Object.assign(new Error('commit denied'), { code: phase === 'history' ? 'ENOSPC' : 'EACCES' });
      }
      fs.renameSync(from, to);
    },
    unlinkSync(file) {
      if (failing && phase === 'commit' && file === `${metadata}.commit.json`) {
        failing = false; throw Object.assign(new Error('commit denied'), { code: 'EACCES' });
      }
      fs.unlinkSync(file);
    },
  });
  const session = new ConversationSession(root, () => now, 'session.json', { localHistory: true, durablePrevious: true, repository });
  session.threadId = id; session.answered({ prompt: 'first', answer: 'first answer' });
  const before = fs.readFileSync(metadata, 'utf8'), history = fs.readFileSync(join(root, `${id}.json`), 'utf8');
  now++; failing = true;
  assert.throws(() => session.answered({ prompt: 'second', answer: 'second answer' }), /commit denied/);
  assert.deepEqual(session.currentExchanges, [{ question: 'first', answer: 'first answer' }]);
  assert.equal(fs.readFileSync(metadata, 'utf8'), before);
  assert.equal(fs.readFileSync(join(root, `${id}.json`), 'utf8'), history);
  assert.ok(!fs.existsSync(`${metadata}.commit.json`));
  session.answered({ prompt: 'second', answer: 'second answer' });
  assert.equal(session.currentExchanges.length, 2);
});

for (const action of ['reset', 'forget', 'restore'] as const) test(`failed ${action} does not publish session transition`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-commit-')), metadata = join(root, 'session.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  let failing = false;
  const repository = new ConversationRepository(metadata, { ...fs, renameSync(from, to) {
    if (failing && to === metadata) { failing = false; throw new Error('EACCES'); }
    fs.renameSync(from, to);
  } });
  const session = new ConversationSession(root, () => 1000, 'session.json', { localHistory: true, durablePrevious: true, repository });
  session.threadId = id; session.answered({ prompt: 'Q', answer: 'A' });
  if (action === 'restore') session.reset();
  const before = { id: session.threadId, previous: session.previousConversationId, exchanges: session.currentExchanges };
  failing = true;
  assert.throws(() => action === 'reset' ? session.reset() : action === 'forget' ? session.forget([id]) : session.restorePrevious(), /EACCES/);
  assert.deepEqual({ id: session.threadId, previous: session.previousConversationId, exchanges: session.currentExchanges }, before);
});

for (const phase of ['history', 'metadata'] as const) test(`restart rolls back crash after ${phase} replacement before commit`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-crash-')), metadata = join(root, 'session.json'), historyFile = join(root, `${id}.json`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new ConversationSession(root, () => 1000, 'session.json', { localHistory: true, durablePrevious: true });
  first.threadId = id; first.answered({ prompt: 'Q', answer: 'A' });
  const oldMetadata = fs.readFileSync(metadata, 'utf8'), oldHistory = fs.readFileSync(historyFile, 'utf8');
  // Exact prepared journal and interrupted file state produced by the repository.
  fs.writeFileSync(`${metadata}.commit.json`, JSON.stringify({ version: 1, metadata: oldMetadata, history: { id, contents: oldHistory } }));
  fs.writeFileSync(historyFile, JSON.stringify([{ question: 'unfinished', answer: 'unfinished' }]));
  if (phase === 'metadata') fs.writeFileSync(metadata, JSON.stringify({ threadId: id, lastAnswerAt: 1001 }));
  const restarted = new ConversationSession(root, () => 1001, 'session.json', { localHistory: true, durablePrevious: true });
  restarted.loadLocalHistory();
  assert.deepEqual(restarted.currentExchanges, [{ question: 'Q', answer: 'A' }]);
  assert.equal(fs.readFileSync(metadata, 'utf8'), oldMetadata);
  assert.ok(!fs.existsSync(`${metadata}.commit.json`));
});
