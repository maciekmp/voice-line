import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ConversationSession } from '../src/conversation-session.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../src/conversation-retention.ts';
import { appDataDirectory, createAppStorage } from '../src/app-storage.ts';
import { CodexAppServer } from '../src/codex-app-server.ts';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const image = { id: 'a'.repeat(64), alt: 'Obraz' };
const reply = { prompt: 'Pytanie', answer: 'Odpowiedź' };
const { saveConversation } = createRequire(import.meta.url)('../electron/conversation-export.cjs');
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
        const notify = (method: string, item: object) => (server as any).onLine(JSON.stringify({ method, params: { threadId: second, turnId: 'turn_test', ...item } }));
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
