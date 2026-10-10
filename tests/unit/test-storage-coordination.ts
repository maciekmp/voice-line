import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, stat, readdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';
import { StorageBusyError } from '../../src/storage-coordinator.ts';
import { ArtifactStore, imageFromProtocol } from '../../src/artifact-store.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { createAppStorage, type AppStorage } from '../../src/app-storage.ts';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const third = '33333333-3333-3333-3333-333333333333';
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'voice-storage-coordination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000;
  const home = join(root, 'local-codex');
  const retention = new ConversationRetention(home, root, () => now);
  const peer = new ConversationRetention(home, root, () => now);
  return { root, home, retention, peer, expire: () => { now += HISTORY_TTL_MS; } };
}

test('active conversation cannot be deleted by another retention instance', async t => {
  const { retention, peer, expire } = await fixture(t);
  retention.touch(first);
  const release = await peer.acquireActivity(first);
  expire();
  let calls = 0;
  assert.deepEqual(await retention.prune(async () => { calls++; }), []);
  assert.equal(calls, 0);
  assert.equal(retention.cleanupHealth.reason, 'active-conversation');
  release(); release();
  assert.deepEqual(await retention.prune(async () => { calls++; }), [first]);
  assert.equal(calls, 1);
});

test('delete claim prevents resurrection while another candidate may be renewed', async t => {
  const { retention, peer, home, expire } = await fixture(t);
  retention.touch(first); retention.touch(second); expire();
  const entered = barrier(), finish = barrier();
  const deleted: string[] = [];
  const cleanup = retention.prune(async id => {
    deleted.push(id); entered.resolve(); await finish.promise;
  });
  await entered.promise;
  const before = await readFile(join(home, 'history-index.json'), 'utf8');
  assert.throws(() => peer.touch(first), StorageBusyError);
  assert.equal(await readFile(join(home, 'history-index.json'), 'utf8'), before);
  peer.touch(second);
  finish.resolve();
  assert.deepEqual(await cleanup, [first]);
  assert.deepEqual(deleted, [first]);
  const index = JSON.parse(await readFile(join(home, 'history-index.json'), 'utf8'));
  assert.equal(index[first], undefined); assert.equal(index[second].revision, 2);
});

test('new references cannot attach an image task already claimed for deletion', async t => {
  const { root, retention, expire } = await fixture(t);
  let imageNow = 0;
  const images = new ConversationRetention(join(root, 'imagegen-codex'), root, () => imageNow);
  images.touch(first); expire(); imageNow += HISTORY_TTL_MS;
  const entered = barrier(), finish = barrier();
  const cleanup = images.prune(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  assert.throws(() => retention.touch(second, [], { threadId: first, turnId: 'turn_1' }), StorageBusyError);
  finish.resolve(); await cleanup;
});

test('shared PNG cleanup waits for active operations and retries without repeating remote delete', async t => {
  const { root, retention, peer, expire } = await fixture(t);
  const image = 'a'.repeat(64), file = join(root, 'images', `${image}.png`);
  await mkdir(join(root, 'images')); await writeFile(file, 'pixels');
  retention.touch(first, [{ id: image, alt: 'image' }]); expire();
  const release = await peer.acquireActivity(third);
  let calls = 0;
  assert.deepEqual(await retention.prune(async () => { calls++; }), [first]);
  await access(file);
  release();
  assert.deepEqual(await retention.prune(async () => { calls++; }), [first]);
  assert.equal(calls, 1);
  await assert.rejects(access(file));
});

test('parallel artifact writers retain both links and repeated task IDs are idempotent', async t => {
  const { root } = await fixture(t);
  const a = new ArtifactStore(root), b = new ArtifactStore(root);
  await Promise.all([
    a.appendLink(first, { threadId: second, turnId: 'turn_a', anchor: 0 }),
    b.appendLink(first, { threadId: third, turnId: 'turn_b', anchor: 1 }),
    b.appendLink(first, { threadId: second, turnId: 'turn_a', anchor: 2 }),
  ]);
  assert.deepEqual(await a.readLinks(first), [
    { threadId: second, turnId: 'turn_a', anchor: 0 },
    { threadId: third, turnId: 'turn_b', anchor: 1 },
  ]);
  assert.equal((await readdir(join(root, 'image-links'))).length, 1);
});

test('unreferenced blobs survive the adoption window and active operations, then expire', async t => {
  const { root, retention, peer, expire } = await fixture(t);
  const orphan = 'b'.repeat(64), preserved = 'c'.repeat(64);
  const directory = join(root, 'images');
  await mkdir(directory);
  const file = join(directory, `${orphan}.png`);
  await writeFile(file, 'orphan'); await utimes(file, new Date(1000), new Date(1000));
  await writeFile(join(directory, `${preserved}.png.corrupt-backup`), 'preserve');
  await retention.prune(async () => assert.fail('no registered conversations'));
  await access(file);
  const release = await peer.acquireActivity();
  expire();
  await retention.prune(async () => assert.fail('no registered conversations'));
  await access(file);
  release();
  await retention.prune(async () => assert.fail('no registered conversations'));
  await assert.rejects(access(file));
  await access(join(directory, `${preserved}.png.corrupt-backup`));
});

test('ensuring existing PNG preserves mtime and damaged bytes are quarantined before replacement', async t => {
  const { root } = await fixture(t);
  const store = new ArtifactStore(root);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const mapped = imageFromProtocol({ status: 'completed', result: bytes.toString('base64') });
  await store.ensure(mapped.image, bytes);
  const file = join(root, 'images', `${mapped.image.id}.png`);
  await utimes(file, new Date(1000), new Date(1000));
  const before = (await stat(file)).mtimeMs;
  await Promise.all([store.ensure(mapped.image, bytes), new ArtifactStore(root).ensure(mapped.image, bytes)]);
  assert.equal((await stat(file)).mtimeMs, before);
  await writeFile(file, 'damaged');
  await store.ensure(mapped.image, bytes);
  assert.deepEqual(await readFile(file), bytes);
  const backup = (await readdir(join(root, 'images'))).find(name => name.includes('.corrupt-'))!;
  assert.equal(await readFile(join(root, 'images', backup), 'utf8'), 'damaged');
  assert.equal((await readdir(join(root, 'images'))).some(name => name.endsWith('.tmp')), false);
});

test('provider holds storage lease through remote turn and releases it after commit or failure', async t => {
  const { root, retention, peer, expire } = await fixture(t);
  const storage = createAppStorage('local', root);
  storage.retention = retention;
  class Provider extends CodexAppServer {
    entered = barrier();
    finish = barrier();
    fail = false;
    constructor(storage: AppStorage) { super(root, storage.session, false, { storage }); }
    override async start() {}
    protected override async request(method: string): Promise<any> {
      if (method === 'thread/start') return { thread: { id: first } };
      if (method === 'turn/start') {
        this.entered.resolve(); await this.finish.promise;
        if (this.fail) throw new Error('remote failure');
        queueMicrotask(() => {
          const emit = (method: string, params: object) => (this as any).onMessage({ method, params: { threadId: first, ...params } });
          emit('item/completed', { item: { type: 'agentMessage', text: '{"prompt":"question","answer":"answer"}' } });
          emit('turn/completed', { turn: { id: 'turn_1', status: 'completed' } });
        });
        return { turn: { id: 'turn_1' } };
      }
      return {};
    }
  }
  const provider = new Provider(storage);
  const response = provider.respond('question');
  await provider.entered.promise;
  expire();
  let deleted = 0;
  assert.deepEqual(await peer.prune(async () => { deleted++; }), []);
  provider.finish.resolve(); await response;
  assert.equal(storage.session.currentExchanges.length, 1);
  expire();
  assert.deepEqual(await peer.prune(async () => { deleted++; }), [provider.currentThreadId]);
  assert.equal(deleted, 1);

  provider.reset(); provider.entered = barrier(); provider.finish = barrier(); provider.fail = true;
  const failed = provider.respond('fail');
  const rejected = assert.rejects(failed, /remote failure/);
  await provider.entered.promise;
  expire();
  assert.deepEqual(await peer.prune(async () => { deleted++; }), []);
  provider.finish.resolve(); await rejected;
  assert.deepEqual(await peer.prune(async () => { deleted++; }), [provider.currentThreadId]);
  assert.equal(deleted, 2);
});
