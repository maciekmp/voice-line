import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWorkerRequestHandler } from '../../src/worker-host.ts';
const require = createRequire(import.meta.url);
const { createEngineSupervisor } = require('../../electron/engine-supervisor.cjs');
const { parseWorkerResult } = require('../../src/worker-validation.cjs');

test('real process IPC acknowledges admission before completion and rejects concurrent commands', async t => {
  const events: any[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const supervisor = createEngineSupervisor({
    launch: () => spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../helpers/application-worker.ts', import.meta.url))], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    }),
    onMessage(event: any) {
      events.push(event);
      if (event.ready && event.state === 'idle') {
        if (event.conversation.completed.length) complete(); else ready();
      }
    },
  });
  t.after(() => supervisor.stop());
  supervisor.start(); await started;
  const result = await supervisor.request({ command: 'text', text: 'hello' });
  assert.deepEqual(result, { accepted: true, operationId: 1 });
  const thinking = events.findLast(event => event.type === 'voice');
  assert.equal(thinking.state, 'thinking');
  assert.deepEqual(thinking.conversation.completed, []);
  assert.deepEqual(await supervisor.request({ command: 'text', text: 'overlap' }), { accepted: false, reason: 'busy' });
  assert.deepEqual(await supervisor.request({ command: 'text', text: ' ' }), { accepted: false, reason: 'invalid' });
  await completed;
  assert.equal(events.at(-1).conversation.completed[0].answer, 'worker:hello');
});

test('command result validation rejects malformed IDs and result variants', () => {
  const accepted = { type: 'command-result', requestId: 1, result: { accepted: true, operationId: null } };
  assert.deepEqual(parseWorkerResult(accepted), accepted);
  for (const value of [null, [], {}, { ...accepted, requestId: 0 }, { ...accepted, requestId: 1.5 },
    { ...accepted, result: { accepted: 'true', operationId: null } },
    { ...accepted, result: { accepted: true, operationId: -1 } },
    { ...accepted, result: { accepted: false, reason: 'invented' } }]) assert.equal(parseWorkerResult(value), null);
});

test('worker rejects malformed request envelopes without invoking application code', () => {
  let dispatched = 0, replies = 0;
  const dispatch = () => { dispatched++; return { result: { accepted: true as const, operationId: null }, completion: Promise.resolve() }; };
  const receive = createWorkerRequestHandler({ dispatch }, async () => {}, () => { replies++; });
  for (const value of [null, [], {}, { type: 'request', requestId: -1, command: { command: 'reset' } },
    { type: 'request', requestId: 1.5, command: { command: 'reset' } }]) assert.equal(receive(value), false);
  assert.equal(dispatched, 0); assert.equal(replies, 0);
});
