import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRpcTransport } from '../../src/codex-rpc-transport.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { ConversationSession } from '../../src/conversation-session.ts';
import type { AppStorage } from '../../src/app-storage.ts';
import { CodexClient } from '../../src/codex.ts';

function processFixture(stdin: Writable = new PassThrough()) {
  const child = Object.assign(new EventEmitter(), {
    stdin, stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kills: 0,
    kill() { this.kills++; return true; },
  });
  return { child, process: child as unknown as ChildProcessWithoutNullStreams };
}

test('transport matches replies, forwards notifications and rejects RPC errors without disconnecting', async () => {
  const fixture = processFixture(), messages: any[] = [], errors: Error[] = [];
  const transport = new CodexRpcTransport(fixture.process, message => messages.push(message), error => errors.push(error));
  const first = transport.request('first', {}), second = transport.request('second', {});
  fixture.child.stdout.write('bad JSON\nnull\n');
  fixture.child.stdout.write('{"id":2,"result":"second"}\n{"method":"event","params":{}}\n');
  fixture.child.stdout.write('{"id":1,"error":{"message":"denied"}}\n');
  assert.equal(await second, 'second');
  await assert.rejects(first, /denied/);
  assert.deepEqual(messages, [{ method: 'event', params: {} }]);
  assert.equal(errors.length, 0);
  transport.stop();
});

test('asynchronous EPIPE rejects every pending request and disconnects once', async () => {
  const pipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  const fixture = processFixture(new Writable({ write(_chunk, _encoding, callback) {
    setImmediate(() => callback(pipeError));
  } }));
  const errors: Error[] = [];
  const transport = new CodexRpcTransport(fixture.process, () => assert.fail('late message'), error => errors.push(error));
  const results = await Promise.allSettled([transport.request('first', {}), transport.request('second', {})]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === pipeError));
  fixture.child.emit('error', pipeError);
  fixture.child.emit('close', 1);
  fixture.child.stdout.write('{"method":"late"}\n');
  assert.deepEqual(errors, [pipeError]);
  assert.equal(fixture.child.kills, 1);
  await assert.rejects(transport.request('retry-on-dead-connection', {}), /broken pipe/);
});

for (const source of ['stdin', 'stdout', 'stderr', 'process'] as const) test(`${source} error while awaiting response is controlled`, async () => {
  const fixture = processFixture(), errors: Error[] = [];
  const transport = new CodexRpcTransport(fixture.process, () => {}, error => errors.push(error));
  const pending = transport.request('waiting', {});
  const error = new Error(`${source} failure`);
  const rejected = assert.rejects(pending, error);
  (source === 'process' ? fixture.child : fixture.child[source]).emit('error', error);
  await rejected;
  fixture.child.emit('close', 1);
  assert.deepEqual(errors, [error]);
});

test('stop rejects pending requests and absorbs delayed errors from every stream', async () => {
  const fixture = processFixture(), errors: Error[] = [];
  const transport = new CodexRpcTransport(fixture.process, () => {}, error => errors.push(error));
  const pending = transport.request('waiting', {});
  const rejected = assert.rejects(pending, /stopped/);
  transport.stop();
  await rejected;
  for (const stream of [fixture.child.stdin, fixture.child.stdout, fixture.child.stderr]) stream.emit('error', new Error('late pipe failure'));
  fixture.child.emit('error', new Error('late process failure'));
  fixture.child.emit('close', 0);
  transport.stop();
  assert.equal(errors.length, 1);
  assert.equal(fixture.child.kills, 1);
});

test('closed input and ended output reject waiting requests', async () => {
  for (const source of ['stdin', 'stdout'] as const) {
    const fixture = processFixture();
    const transport = new CodexRpcTransport(fixture.process, () => {}, () => {});
    const pending = transport.request('waiting', {});
    const rejected = assert.rejects(pending, /closed|ended/);
    if (source === 'stdin') fixture.child.stdin.destroy();
    else fixture.child.stdout.end();
    await rejected;
  }
});

test('request deadline clears pending state and allows a later request', async () => {
  const fixture = processFixture(), transport = new CodexRpcTransport(fixture.process, () => {}, () => {});
  await assert.rejects(transport.request('deadline', {}, 5), /timed out/);
  fixture.child.stdout.write('{"id":1,"result":"late"}\n');
  const next = transport.request('next', {});
  fixture.child.stdout.write('{"id":2,"result":"ok"}\n');
  assert.equal(await next, 'ok');
  transport.stop();
});

test('server requests with colliding and string IDs receive errors without settling client requests', async () => {
  const writes: any[] = [], notifications: any[] = [];
  const fixture = processFixture(new Writable({ write(chunk, _encoding, callback) {
    writes.push(JSON.parse(chunk.toString())); callback();
  } }));
  const transport = new CodexRpcTransport(fixture.process, message => notifications.push(message), () => {});
  let settled = false;
  const pending = transport.request('thread/read', {}).then(value => { settled = true; return value; });
  fixture.child.stdout.write('{"id":1,"method":"item/tool/requestUserInput","params":{}}\n');
  fixture.child.stdout.write('{"id":"server-id","method":"unknown"}\n');
  fixture.child.stdout.write('{"id":1}\n{"id":1,"result":"bad","error":{}}\n');
  fixture.child.stdout.write('{"method":"notification","params":{}}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(writes.slice(1).map(reply => [reply.id, reply.error.code]), [[1, -32601], ['server-id', -32601]]);
  assert.equal(notifications.length, 1);
  fixture.child.stdout.write('{"id":1,"result":"actual history"}\n');
  assert.equal(await pending, 'actual history');
  transport.stop();
});

test('server request handler returns a result or controlled internal error', async () => {
  const writes: any[] = [];
  const fixture = processFixture(new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(chunk.toString())); callback(); } }));
  const transport = new CodexRpcTransport(fixture.process, () => {}, () => {}, method => {
    if (method === 'approval') return { decision: 'decline' };
    throw new Error('handler failed');
  });
  fixture.child.stdout.write('{"id":10,"method":"approval"}\n{"id":11,"method":"failure"}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes.find(reply => reply.id === 10), { id: 10, result: { decision: 'decline' } });
  assert.deepEqual(writes.find(reply => reply.id === 11), { id: 11, error: { code: -32603, message: 'handler failed' } });
  transport.stop();
});

test('app-server rejects an active turn on pipe failure, then starts a fresh connection', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-transport-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const fixtures: ReturnType<typeof processFixture>[] = [];
  let started!: () => void;
  const turnStarted = new Promise<void>(resolve => { started = resolve; });
  class Server extends CodexAppServer {
    exits: Error[] = [];
    protected override onServerExit(error: Error) { this.exits.push(error); }
    protected override launchServer() {
      let fixture: ReturnType<typeof processFixture>;
      fixture = processFixture(new Writable({ write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        callback();
        if (!request.id) return;
        setImmediate(() => {
          const result = request.method === 'thread/start' ? { thread: { id: '11111111-1111-1111-1111-111111111111' } }
            : request.method === 'turn/start' ? { turn: { id: 'turn_test' } }
            : request.method === 'thread/read' ? { thread: { id: request.params.threadId, turns: [] } } : {};
          fixture.child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
          if (request.method === 'turn/start') started();
        });
      } }));
      fixtures.push(fixture);
      return fixture.process;
    }
  }
  const server = new Server(cwd, new ConversationSession(cwd), true);
  t.after(() => server.stop());
  const response = server.respond('Test');
  const rejected = assert.rejects(response, /pipe failure/);
  await turnStarted;
  // Let runTurn finish receiving turn/start before breaking the stream.
  await new Promise(resolve => setImmediate(resolve));
  fixtures[0].child.stdin.emit('error', new Error('pipe failure'));
  await rejected;
  assert.equal(server.exits.length, 1);
  await server.start();
  assert.equal(fixtures.length, 2);
  fixtures[0].child.emit('close', 1);
  fixtures[0].child.stdout.emit('error', new Error('stale failure'));
  assert.equal(server.exits.length, 1);
});

test('worker survives real asynchronous Writable EPIPE and can publish a controlled error', async () => {
  const moduleUrl = new URL('../../src/codex-rpc-transport.ts', import.meta.url).href;
  const script = `
    const { CodexRpcTransport } = await import(${JSON.stringify(moduleUrl)});
    const { EventEmitter } = await import('node:events');
    const { Writable, PassThrough } = await import('node:stream');
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, encoding, callback) {
        setImmediate(() => callback(Object.assign(new Error('EPIPE'), { code: 'EPIPE' })));
      }}), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() {}
    });
    const transport = new CodexRpcTransport(child, () => {}, () => {});
    try { await transport.request('test', {}); }
    catch (error) { process.stdout.write('controlled:' + error.code); }
    await new Promise(resolve => setImmediate(resolve));
  `;
  const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script]);
  assert.equal(result.stdout, 'controlled:EPIPE');
  assert.equal(result.stderr, '');
});

test('stop during storage preparation cannot launch an app-server after shutdown', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-transport-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let ready!: () => void;
  const preparation = new Promise<void>(resolve => { ready = resolve; });
  class Server extends CodexAppServer {
    protected override launchServer(): never { assert.fail('shutdown must prevent subprocess launch'); }
  }
  const server = new Server(cwd, new ConversationSession(cwd), true, { storage: { prepare: () => preparation } as AppStorage });
  const startup = server.start(); server.stop(); ready();
  await assert.rejects(startup, /startup stopped/);
});

test('stop during CLI history import cannot create its history app-server', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-transport-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const client = new CodexClient(cwd);
  const startup = client.start(); client.stop();
  await assert.rejects(startup, /startup stopped/);
});
