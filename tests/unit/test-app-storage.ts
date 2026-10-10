import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ConversationSession } from '../../src/conversation-session.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';
import { appDataDirectory, createAppStorage } from '../../src/app-storage.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const image = { id: 'a'.repeat(64), alt: 'Obraz' };
const reply = { prompt: 'Pytanie', answer: 'Odpowiedź' };
const { saveConversation } = createRequire(import.meta.url)('../../electron/conversation-export.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
async function directory(t: any) {
  const data = await mkdtemp(join(tmpdir(), 'voice-storage-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
}

test('one data root is independent of the project, with explicit override and isolated modes', async t => {
  const data = await directory(t);
  assert.equal(appDataDirectory({ LOCALAPPDATA: data }), join(data, 'ChatGPTButton'));
  assert.equal(appDataDirectory({ CHATGPT_BUTTON_DATA_DIR: data }), data);
  const local = createAppStorage('local', data), realtime = createAppStorage('realtime', data);
  assert.notEqual(local.home, realtime.home);
  assert.equal(local.ephemeral, true);
  assert.equal(createAppStorage('imagegen', data).ephemeral, true);
  assert.equal(realtime.ephemeral, false);
  await assert.rejects(access(local.home)); // Resolving paths never creates production directories.
});

test('private startup never copies or modifies shared login, config or history', async t => {
  const data = await directory(t), source = join(data, 'shared');
  await mkdir(source);
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'fake-test-access', refresh_token: 'fake-test-refresh' } };
  await writeFile(join(source, 'auth.json'), JSON.stringify(auth));
  await writeFile(join(source, 'config.toml'), 'sqlite_home="shared"');
  await writeFile(join(source, 'history.jsonl'), 'shared conversation');
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = source;
  try {
    for (const mode of ['local', 'realtime', 'imagegen'] as const) {
      const storage = createAppStorage(mode, data);
      await storage.prepare();
      for (const file of ['auth.json', 'history.jsonl', 'config.toml']) await assert.rejects(access(join(storage.home, file)));
    }
  } finally { if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original; }
  assert.deepEqual(JSON.parse(await readFile(join(source, 'auth.json'), 'utf8')), auth);
  assert.equal(await readFile(join(source, 'history.jsonl'), 'utf8'), 'shared conversation');
});

test('reset and expiry keep a durable previous reference, restoring messages only from Codex', async t => {
  const data = await directory(t);
  let now = 1_000_000;
  const create = () => new ConversationSession(data, () => now, 'session.json', { durablePrevious: true });
  const session = create();
  session.threadId = first; session.answered(reply); session.reset();
  const restarted = create();
  assert.equal(restarted.threadId, null);
  assert.equal(restarted.previousConversationId, first);
  assert.equal(restarted.canRestorePrevious, false);
  restarted.loadHistory(first, [{ question: reply.prompt, answer: reply.answer }]);
  assert.equal(restarted.restorePrevious(), true);
  restarted.reset(); restarted.threadId = second; restarted.answered(reply);
  assert.equal(create().previousConversationId, first);
  now += 120_000;
  assert.equal(create().threadId, null);
  assert.equal(create().previousConversationId, second);
  const metadata = JSON.parse(await readFile(join(data, 'session.json'), 'utf8'));
  assert.deepEqual(Object.keys(metadata).sort(), ['lastAnswerAt', 'previousLastAnswerAt', 'previousThreadId', 'threadId']);
});

test('ephemeral app history survives restart, reset and undo; expiry deletes files without Codex RPC', async t => {
  const data = await directory(t);
  const storage = createAppStorage('local', data);
  storage.session.threadId = first;
  storage.session.answered({ ...reply, images: [image] });
  storage.retention.touch(first, [image]);
  storage.session.reset();
  const restarted = createAppStorage('local', data);
  assert.equal(restarted.session.canRestorePrevious, true);
  assert.equal(restarted.session.restorePrevious(), true);
  assert.deepEqual(restarted.session.currentExchanges[0].images, [image]);
  assert.match(restarted.session.contextPrompt('Następne pytanie'), /Odpowiedź/);
  restarted.retention = new ConversationRetention(restarted.home, data, () => Date.now() + HISTORY_TTL_MS + 1000);
  const server = new CodexAppServer(data, restarted.session, true, { storage: restarted });
  Object.assign(server, { request: () => { throw new Error('Must not read or delete global Codex history'); } });
  assert.equal(await server.maintainHistory(), true);
  await assert.rejects(access(join(restarted.home, `${first}.json`)));
  assert.equal(restarted.session.threadId, null);
  assert.equal(restarted.session.canRestorePrevious, false);
});

test('ephemeral ImageGen saves pixels and app history without a persisted Codex thread', async t => {
  const data = await directory(t), storage = createAppStorage('imagegen', data);
  const server = new CodexAppServer(data, storage.session, true, { storage });
  const requests: string[] = [];
  Object.assign(server, {
    start: async () => {},
    request: async (method: string, params: any) => {
      requests.push(method);
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'modelProvider/capabilities/read') return { imageGeneration: true };
      if (method === 'thread/start') { assert.equal(params.ephemeral, true); return { thread: { id: second } }; }
      if (method === 'thread/unsubscribe') return {};
      assert.equal(method, 'turn/start');
      setTimeout(() => {
        const notify = (method: string, item: object) => (server as any).onMessage({ method, params: { threadId: second, turnId: 'turn_test', ...item } });
        notify('item/completed', { item: { type: 'imageGeneration', status: 'completed', result: png.toString('base64') } });
        notify('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
        notify('turn/completed', { turn: { id: 'turn_test', status: 'completed' } });
      }, 0);
      return { turn: { id: 'turn_test' } };
    },
  });
  const result = await server.generateImage('Wygeneruj obraz');
  assert.equal(result.images?.length, 1);
  const restarted = createAppStorage('imagegen', data);
  assert.deepEqual(restarted.session.currentExchanges[0].images, result.images);
  assert.deepEqual(await readFile(join(data, 'images', `${result.images![0].id}.png`)), png);
  assert.ok(!requests.includes('thread/resume'));
  assert.ok(!requests.includes('thread/read'));
});

test('local history is explicitly loaded after construction with loaded/missing/corrupt results', async t => {
  const data = await directory(t);
  const session = new ConversationSession(data, Date.now, 'session.json', { durablePrevious: true, localHistory: true });
  assert.deepEqual(session.readLocalHistoryResult(first), { status: 'missing', id: first });
  await writeFile(join(data, `${first}.json`), '[null]');
  assert.equal(session.readLocalHistoryResult(first).status, 'corrupt');
  assert.throws(() => session.readLocalHistory(first), /Invalid application conversation/);
  await writeFile(join(data, `${first}.json`), JSON.stringify([{ question: reply.prompt, answer: reply.answer }]));
  await writeFile(join(data, 'session.json'), JSON.stringify({ threadId: first, lastAnswerAt: Date.now() }));
  const restarted = new ConversationSession(data, Date.now, 'session.json', { durablePrevious: true, localHistory: true });
  assert.equal(restarted.currentExchanges.length, 0);
  assert.equal(restarted.loadLocalHistory()[0].status, 'loaded');
  assert.equal(restarted.currentExchanges[0].answer, reply.answer);
});

test('corrupt current or previous history is isolated, preserving the other conversation and original bytes', async t => {
  const invalidHistories = [
    '{broken JSON', '[null]', '{}',
    JSON.stringify([{ question: 'Q', answer: 'A', images: [null] }]),
    JSON.stringify([{ question: 'Q', answer: 'A', images: [{ id: '../image', alt: 'image' }] }]),
    JSON.stringify([{ question: 'Q', answer: 'A', images: [{ id: image.id, alt: null }] }]),
    JSON.stringify([{ question: 'Q', answer: 'A', imageTask: { threadId: '../task', turnId: 'turn' } }]),
    JSON.stringify([{ question: 'Q', answer: 'A', imageTask: { threadId: first, turnId: '../turn' } }]),
  ];
  for (const mode of ['local', 'imagegen'] as const) for (const role of ['current', 'previous'] as const) {
    for (const [index, content] of invalidHistories.entries()) await t.test(`${mode} ${role} invalid fixture ${index}`, async t => {
      const data = await directory(t), home = join(data, `${mode}-codex`);
      await mkdir(home);
      const current = role === 'current' ? first : second;
      const previous = role === 'previous' ? first : second;
      await writeFile(join(home, 'session.json'), JSON.stringify({ threadId: current, lastAnswerAt: Date.now(),
        previousThreadId: previous, previousLastAnswerAt: Date.now() }));
      const healthy = JSON.stringify([{ question: reply.prompt, answer: reply.answer, images: [image],
        imageTask: { threadId: second, turnId: 'turn_test' } }]);
      await writeFile(join(home, `${first}.json`), content);
      await writeFile(join(home, `${second}.json`), healthy);
      const storage = createAppStorage(mode, data);
      const corrupt = storage.historyLoadResults.find(result => result.id === first)!;
      assert.equal(corrupt.status, 'corrupt');
      if (corrupt.status !== 'corrupt') assert.fail('expected corrupt result');
      assert.equal(await readFile(corrupt.preservedFile!, 'utf8'), content);
      await assert.rejects(access(join(home, `${first}.json`)));
      const migrated = JSON.parse(await readFile(join(home, `${second}.json`), 'utf8'));
      assert.equal(migrated.version, 2);
      assert.deepEqual(migrated.exchanges.map(({ id, revision, ...exchange }: any) => exchange), JSON.parse(healthy));
      const backup = (await readdir(home)).find(name => name.startsWith(`${second}.json.legacy-`))!;
      assert.equal(await readFile(join(home, backup), 'utf8'), healthy);
      assert.equal(storage.session.threadId, role === 'current' ? null : second);
      assert.equal(storage.session.previousConversationId, role === 'previous' ? null : second);
      assert.equal(storage.session.canRestorePrevious, role === 'current');
      const restarted = createAppStorage(mode, data);
      assert.ok(restarted.historyLoadResults.every(result => result.status === 'loaded'));
      if (role === 'current') assert.equal(restarted.session.restorePrevious(), true);
      // A new answer commits normally and cannot overwrite the preserved damaged file.
      restarted.session.threadId = second;
      restarted.session.answered(reply);
      assert.equal(await readFile(corrupt.preservedFile!, 'utf8'), content);
    });
  }
});

test('missing history clears only its reference and never fabricates a conversation file', async t => {
  const data = await directory(t), home = join(data, 'local-codex');
  await mkdir(home);
  await writeFile(join(home, 'session.json'), JSON.stringify({ threadId: first, lastAnswerAt: Date.now(),
    previousThreadId: second, previousLastAnswerAt: Date.now() }));
  const storage = createAppStorage('local', data);
  assert.deepEqual(storage.historyLoadResults, [{ status: 'missing', id: first }, { status: 'missing', id: second }]);
  assert.equal(storage.session.threadId, null);
  assert.equal(storage.session.canRestorePrevious, false);
  await assert.rejects(access(join(home, `${first}.json`)));
  await assert.rejects(access(join(home, `${second}.json`)));
});

test('expired corrupt history cannot block startup and retention preserves its recovery file', async t => {
  const data = await directory(t), home = join(data, 'local-codex');
  await mkdir(home);
  const old = Date.now() - HISTORY_TTL_MS - 1000;
  await writeFile(join(home, 'session.json'), JSON.stringify({ threadId: first, lastAnswerAt: old }));
  await writeFile(join(home, `${first}.json`), '[null]');
  new ConversationRetention(home, data, () => old).touch(first);
  const storage = createAppStorage('local', data);
  assert.equal(storage.session.threadId, null);
  assert.equal(storage.session.previousConversationId, null);
  const result = storage.historyLoadResults[0];
  assert.equal(result.status, 'corrupt');
  if (result.status !== 'corrupt') assert.fail('expected corrupt result');
  const server = new CodexAppServer(data, storage.session, true, { storage });
  Object.assign(server, { request: () => { throw new Error('No Codex RPC during local cleanup'); } });
  assert.equal(await server.maintainHistory(), true);
  assert.equal(await readFile(result.preservedFile!, 'utf8'), '[null]');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'history-index.json'), 'utf8')), {});
});

test('24-hour cleanup deletes registered threads and clears metadata; fresh and shared history are untouched', async t => {
  const data = await directory(t), home = join(data, 'local-codex');
  let now = 1_000_000;
  const retention = new ConversationRetention(home, data, () => now);
  retention.touch(first);
  now += HISTORY_TTL_MS - 1;
  retention.touch(second);
  const deleted: string[] = [];
  assert.deepEqual(await retention.prune(async id => { deleted.push(id); }), []);
  now++;
  assert.deepEqual(await retention.prune(async id => { deleted.push(id); }), [first]);
  assert.deepEqual(deleted, [first]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(home, 'history-index.json'), 'utf8'))), [second]);
  const session = new ConversationSession(home, () => now, 'session.json', { durablePrevious: true });
  session.threadId = first; session.answered(reply); session.reset(); session.forget([first]);
  assert.equal(new ConversationSession(home, () => now, 'session.json', { durablePrevious: true }).previousConversationId, null);
});

test('failed deletion keeps the index retryable; malformed indexes never send delete requests', async t => {
  const data = await directory(t), home = join(data, 'local-codex');
  let now = 1_000_000;
  const retention = new ConversationRetention(home, data, () => now);
  retention.touch(first); now += HISTORY_TTL_MS;
  await assert.rejects(retention.prune(async () => { throw new Error('offline'); }), /offline/);
  assert.ok(JSON.parse(await readFile(join(home, 'history-index.json'), 'utf8'))[first]);
  assert.deepEqual(await retention.prune(async () => {}), [first]);
  await writeFile(join(home, 'history-index.json'), JSON.stringify({ '../../shared': { updatedAt: 0, images: [] } }));
  await assert.rejects(retention.prune(async () => { assert.fail('must not delete'); }), /Invalid/);
});

test('image tasks and shared PNGs survive while another retained conversation references them', async t => {
  const data = await directory(t);
  let now = 1_000_000;
  const images = new ConversationRetention(join(data, 'imagegen-codex'), data, () => now);
  const voice = new ConversationRetention(join(data, 'realtime-codex'), data, () => now);
  await mkdir(join(data, 'images')); await writeFile(join(data, 'images', `${image.id}.png`), png);
  images.touch(first, [image]);
  now += HISTORY_TTL_MS - 1;
  voice.touch(second, [image], { threadId: first, turnId: 'turn' });
  now++;
  assert.deepEqual(await images.prune(async () => { assert.fail('linked task must survive'); }), []);
  now += HISTORY_TTL_MS;
  await voice.prune(async () => {});
  await access(join(data, 'images', `${image.id}.png`));
  await images.prune(async () => {});
  await assert.rejects(access(join(data, 'images', `${image.id}.png`)));
});

test('artifact cleanup failure is retried after restart without deleting the thread twice', async t => {
  const data = await directory(t), home = join(data, 'local-codex');
  let now = 1000, deletions = 0;
  const retention = new ConversationRetention(home, data, () => now);
  retention.touch(first, [image]); now += HISTORY_TTL_MS;
  // A directory at the expected PNG path produces a deterministic unlink error.
  const blocked = join(data, 'images', `${image.id}.png`);
  await mkdir(blocked, { recursive: true });
  await assert.rejects(retention.prune(async () => { deletions++; }));
  assert.equal(JSON.parse(await readFile(join(home, 'history-index.json'), 'utf8'))[first].deleted, true);
  await rm(blocked, { recursive: true });
  const restarted = new ConversationRetention(home, data, () => now);
  assert.deepEqual(await restarted.prune(async () => { deletions++; }), [first]);
  assert.equal(deletions, 1);
});

test('export embeds images and survives history cleanup; failed export preserves an existing file', async t => {
  const data = await directory(t), images = join(data, 'images'), filename = join(data, 'saved.md');
  await mkdir(images); await writeFile(join(images, `${image.id}.png`), png);
  await saveConversation(filename, [{ question: 'Pytanie', answer: '```ts\nconst x = 1;\n```', images: [image] }], images);
  const content = await readFile(filename, 'utf8');
  assert.ok(content.includes('const x = 1;'));
  assert.ok(content.includes(png.toString('base64')));
  await rm(images, { recursive: true });
  await assert.rejects(saveConversation(filename, [{ question: 'Pytanie', answer: 'Odpowiedź', images: [image] }], images));
  assert.equal(await readFile(filename, 'utf8'), content);
});

test('cleanup cannot run during an external CLI turn and clearing busy permits retry', async t => {
  const data = await directory(t), storage = createAppStorage('realtime', data);
  let deletions = 0;
  storage.retention = new ConversationRetention(storage.home, data, () => HISTORY_TTL_MS + 1000);
  const earlier = new ConversationRetention(storage.home, data, () => 1000);
  earlier.touch(first);
  const server = new CodexAppServer(data, storage.session, true, { home: storage.home, storage });
  Object.assign(server, { request: async (method: string) => { assert.equal(method, 'thread/delete'); deletions++; return {}; } });
  const release = await server.beginExternalTurn();
  assert.equal(deletions, 1);
  earlier.touch(second);
  assert.equal(await server.maintainHistory(), false);
  assert.equal(deletions, 1);
  release();
  assert.equal(await server.maintainHistory(), true);
  assert.equal(deletions, 2);
});
