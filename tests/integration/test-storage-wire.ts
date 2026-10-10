// Installed Codex protocol, isolated temporary home, dummy API key; no inference.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createAppStorage } from '../../src/app-storage.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { CodexClient } from '../../src/codex.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';

const data = await mkdtemp(join(tmpdir(), 'voice-storage-wire-'));
const storage = createAppStorage('local', data);
const testCodexHome = join(data, 'global-codex');
const originalHome = process.env.CODEX_HOME;
const originalSqlite = process.env.CODEX_SQLITE_HOME;
process.env.CODEX_HOME = testCodexHome;
process.env.CODEX_SQLITE_HOME = testCodexHome;
// This test must never copy the user's login.
storage.prepare = async () => { await mkdir(storage.home, { recursive: true }); };
let now = Date.now();
storage.retention = new ConversationRetention(storage.home, data, () => now);
class WireServer extends CodexAppServer {
  rpc(method: string, params: object) { return this.request(method, params); }
}
const server = new WireServer(data, storage.session, false, { home: storage.home, storage, apiKey: 'test-not-a-real-key' });
let lastRequest = '';
const backend = createServer((request, response) => {
  if (request.url !== '/responses') { response.writeHead(404).end(); return; }
  const chunks: Buffer[] = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    lastRequest = Buffer.concat(chunks).toString('utf8');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = JSON.stringify({ prompt: 'Pytanie testowe', answer: 'Odpowiedź testowa' });
    const item = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] };
    const send = (event: object) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: 'response.created', response: { id: 'resp_test', object: 'response', status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp_test', object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  });
});
try {
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address() as { port: number };
  await mkdir(testCodexHome, { recursive: true });
  await (await import('node:fs/promises')).writeFile(join(testCodexHome, 'config.toml'),
    `model_provider="storage_test"\nmodel="test-model"\n[model_providers.storage_test]\nname="Storage test"\nbase_url="http://127.0.0.1:${address.port}"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`);
  await server.start();
  assert.equal((await server.respond('Pytanie testowe')).answer, 'Odpowiedź testowa');
  const id = server.currentThreadId!;
  assert.ok(id);
  const listed = await server.rpc('thread/list', { limit: 100 });
  assert.equal(listed.data.length, 0, 'Ephemeral conversations never enter Codex history');
  assert.equal(JSON.parse(await readFile(join(testCodexHome, 'auth.json'), 'utf8')).OPENAI_API_KEY, 'test-not-a-real-key');
  await assert.rejects(readFile(join(storage.home, 'auth.json')));
  assert.equal(JSON.parse(await readFile(join(storage.home, `${id}.json`), 'utf8'))[0].answer, 'Odpowiedź testowa');
  storage.session.reset();
  const restarted = createAppStorage('local', data);
  assert.equal(restarted.session.restorePrevious(), true);
  assert.match(restarted.session.contextPrompt('Dalej'), /Odpowiedź testowa/);
  const restartedServer = new WireServer(data, restarted.session, false, { storage: restarted });
  try {
    await restartedServer.respond('Dalej po restarcie');
    assert.match(lastRequest, /Odpowiedź testowa/);
    assert.match(lastRequest, /Dalej po restarcie/);
    assert.equal((await restartedServer.rpc('thread/list', { limit: 100 })).data.length, 0);
  } finally { restartedServer.stop(); }
  now = Date.now() + HISTORY_TTL_MS + 1000;
  assert.equal(await server.maintainHistory(), true);
  assert.equal(server.currentThreadId, null);
  assert.deepEqual(JSON.parse(await readFile(join(storage.home, 'history-index.json'), 'utf8')), {});
  const after = await server.rpc('thread/list', { limit: 100 });
  assert.ok(!after.data.some((thread: any) => thread.id === id));
  await assert.rejects(server.rpc('thread/read', { threadId: id, includeTurns: false }));
  const empty = (await server.rpc('thread/start', { cwd: data, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true })).thread.id;
  storage.retention.touch(empty);
  now += HISTORY_TTL_MS;
  assert.equal(await server.maintainHistory(), true, 'Unanswered threads are also cleaned up');
  const cli = new CodexClient(data, 'codex.cmd', storage);
  // Reuse the initialized test history server; its fake provider needs no ChatGPT login.
  Object.assign(cli, { start: async () => {}, historyServer: server });
  assert.equal((await cli.respond('Pytanie CLI')).answer, 'Odpowiedź testowa');
  assert.ok(cli.currentThreadId);
  await cli.respond('Kolejne pytanie CLI');
  assert.match(lastRequest, /Odpowiedź testowa/);
  assert.match(lastRequest, /Kolejne pytanie CLI/);
  now += HISTORY_TTL_MS;
  assert.equal(await server.maintainHistory(), true, 'CLI app history expires without deleting global Codex threads');
  assert.equal((await server.rpc('thread/list', { limit: 100 })).data.length, 0);
  console.log('Ephemeral app-server/CLI, existing account and durable app history: passed (mock inference only)');
} finally {
  server.stop();
  backend.closeAllConnections();
  await new Promise<void>(resolve => backend.close(() => resolve()));
  await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
  if (originalSqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = originalSqlite;
}
