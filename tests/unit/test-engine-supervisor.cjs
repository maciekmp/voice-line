const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createEngineSupervisor } = require('../../electron/engine-supervisor.cjs');

function fixture() {
  return Object.assign(new EventEmitter(), {
    connected: true, kills: 0, messages: [],
    send(message, callback) { this.messages.push(message); callback?.(); },
    kill() { this.kills++; return true; },
  });
}

test('failed real spawn closes without exit and retry starts a working process', async () => {
  let launches = 0;
  const errors = [];
  let current;
  const supervisor = createEngineSupervisor({
    launch: () => ++launches === 1
      ? spawn('voice-line-nonexistent-executable', [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
      : spawn(process.execPath, ['-e', 'process.on("message", () => process.exit(0))'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }),
    onChild: child => { current = child; }, onError: error => errors.push(error),
  });
  supervisor.start();
  const failed = current;
  let exited = false;
  failed.once('exit', () => { exited = true; });
  await new Promise(resolve => failed.once('close', resolve));
  assert.equal(exited, false);
  assert.equal(supervisor.state, 'stopped');
  assert.equal(errors[0].code, 'ENOENT');
  await supervisor.restart();
  assert.equal(launches, 2);
  assert.ok(current.connected);
  await supervisor.stop();
  assert.equal(supervisor.state, 'stopped');
});

test('two quick retries stop once and ignore stale messages, errors and close', async () => {
  const children = [], messages = [], errors = [];
  const supervisor = createEngineSupervisor({ launch() { const child = fixture(); children.push(child); return child; },
    onMessage: message => messages.push(message), onError: error => errors.push(error) });
  supervisor.start();
  children[0].emit('spawn');
  assert.equal(supervisor.state, 'running');
  const first = supervisor.restart(), second = supervisor.restart();
  assert.equal(first, second);
  assert.equal(supervisor.state, 'stopping');
  assert.deepEqual(children[0].messages, [{ command: 'shutdown' }]);
  children[0].emit('close');
  await first;
  children[0].emit('message', 'stale');
  children[0].emit('error', new Error('stale'));
  children[0].emit('close');
  children[1].emit('message', 'current');
  assert.deepEqual(messages, ['current']);
  assert.deepEqual(errors, []);
  assert.equal(children.length, 2);
  const stopped = supervisor.stop();
  children[1].emit('close');
  await stopped;
});

test('disconnected IPC is killed and unexpected death can restart', () => {
  const children = [], errors = [], stopped = [];
  const supervisor = createEngineSupervisor({ launch() { const child = fixture(); children.push(child); return child; },
    onError: error => errors.push(error), onStopped: () => stopped.push(true) });
  supervisor.start();
  children[0].connected = false;
  children[0].emit('disconnect');
  assert.equal(children[0].kills, 1);
  children[0].emit('close');
  assert.equal(errors.length, 1);
  assert.equal(stopped.length, 1);
  supervisor.start();
  assert.equal(children.length, 2);
  children[1].emit('close');
});

test('stop kills a process without IPC and a worker that ignores shutdown', async () => {
  for (const connected of [false, true]) {
    const child = fixture(); child.connected = connected;
    const supervisor = createEngineSupervisor({ launch: () => child, stopTimeoutMs: 5 });
    supervisor.start();
    const stopped = supervisor.stop();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(child.kills >= 1);
    child.emit('close');
    await stopped;
    assert.equal(supervisor.state, 'stopped');
  }
});

test('IPC send failure is controlled and shutdown prevents a queued restart', async () => {
  const children = [], errors = [];
  let allowed = true;
  const supervisor = createEngineSupervisor({ launch() { const child = fixture(); children.push(child); return child; },
    canStart: () => allowed, onError: error => errors.push(error) });
  supervisor.start();
  children[0].send = (_message, callback) => callback(new Error('IPC closed'));
  assert.equal(supervisor.send({ command: 'record' }), true);
  assert.equal(errors.length, 1);
  assert.equal(children[0].kills, 1);
  const restarted = supervisor.restart();
  allowed = false;
  children[0].emit('close');
  await restarted;
  assert.equal(children.length, 1);
  assert.equal(supervisor.state, 'stopped');
});
