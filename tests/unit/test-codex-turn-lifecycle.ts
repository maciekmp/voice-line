import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { ConversationSession } from '../../src/conversation-session.ts';

for (const mode of ['missing', 'late', 'reset'] as const) test(`deadline recovery: ${mode} interrupt completion`, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-turn-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const children: any[] = [], starts: { connection: number; turnId: string }[] = [];
  let interrupted!: () => void;
  const interrupt = new Promise<void>(resolve => { interrupted = resolve; });
  class Server extends CodexAppServer {
    protected override readonly turnTimeoutMs = 30;
    protected override readonly interruptTimeoutMs = 50;
    protected override launchServer(): ChildProcessWithoutNullStreams {
      const connection = children.length;
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString()); callback();
          if (!request.id) return;
          setImmediate(() => {
            let result: any = {};
            const threadId = '11111111-1111-1111-1111-111111111111';
            if (request.method === 'thread/start') result = { thread: { id: threadId } };
            if (request.method === 'thread/read') result = { thread: { id: threadId, turns: [] } };
            if (request.method === 'turn/start') {
              const turnId = `turn_${starts.length}`;
              starts.push({ connection, turnId }); result = { turn: { id: turnId } };
              if (starts.length > 1) setImmediate(() => {
                child.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId, turnId,
                  item: { type: 'agentMessage', text: JSON.stringify({ prompt: 'Q', answer: 'A' }) } } }) + '\n');
                child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }) + '\n');
              });
            }
            if (request.method === 'turn/interrupt') {
              interrupted();
              if (mode === 'missing' || mode === 'reset') return; // No interrupt acknowledgement either.
              setTimeout(() => child.stdout.write(JSON.stringify({ method: 'turn/completed', params: {
                threadId, turn: { id: 'turn_0', status: 'interrupted' } } }) + '\n'), 10);
            }
            child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
          });
        } }), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kills: 0,
        kill() { this.kills++; return true; },
      });
      children.push(child);
      return child as unknown as ChildProcessWithoutNullStreams;
    }
  }
  const session = new ConversationSession(cwd), server = new Server(cwd, session, true);
  t.after(() => server.stop());
  const first = server.respond('first');
  const rejected = assert.rejects(first, /timed out/);
  await interrupt;
  if (mode === 'reset') server.reset();
  const next = server.respond('second');
  assert.equal(starts.length, 1, 'next turn must wait for recovery');
  await rejected;
  assert.equal((await next).answer, 'A');
  assert.equal(children.length, mode === 'late' ? 1 : 2);
  assert.equal(starts[1].connection, mode === 'late' ? 0 : 1);
  assert.equal(session.currentExchanges.length, 1);
  // Late data from the disconnected connection cannot settle the new operation.
  children[0].stdout.write('{"method":"turn/completed","params":{"threadId":"old","turn":{"id":"turn_0","status":"completed"}}}\n');
});
