import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startKeyboard, type KeyEvent } from '../src/keyboard/copilot-key.ts';
import { launch, collect } from '../src/process.ts';

async function until(check: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for native keyboard bridge');
    await delay(25);
  }
}
function bridge(suppressVk: number) {
  const events: KeyEvent[] = [];
  const errors: string[] = [];
  let ready = false;
  const worker = startKeyboard(event => events.push(event), error => errors.push(error), {
    suppressVk, onReady: () => { ready = true; },
  });
  return { ...worker, events, errors, async ready() {
    await until(() => { if (errors.length) throw new Error(errors.join('\n')); return ready; }, 15000);
  } };
}
async function inject() {
  const script = fileURLToPath(new URL('./inject-test-keys.ps1', import.meta.url));
  const result = await collect(launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]));
  assert.equal(result.code, 0, result.stderr);
}
const pairs = (events: KeyEvent[]) => events.filter(event => event.vk === 135 || event.vk === 133)
  .map(event => [event.vk, event.event]);

test('native hook consumes only the configured key, still reports it, and restores delivery on stop',
  { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
    const observer = bridge(0);
    t.after(() => observer.stop());
    await observer.ready();
    await inject();
    await until(() => pairs(observer.events).length >= 4);
    assert.deepEqual(pairs(observer.events), [[135, 'down'], [135, 'up'], [133, 'down'], [133, 'up']]);
    observer.events.length = 0;

    // Installed last: the blocking hook runs before the passive observer.
    const blocking = bridge(135);
    t.after(() => blocking.stop());
    await blocking.ready();
    await inject();
    await until(() => pairs(blocking.events).length >= 4 && pairs(observer.events).length >= 2);
    assert.deepEqual(pairs(blocking.events), [[135, 'down'], [135, 'up'], [133, 'down'], [133, 'up']]);
    assert.deepEqual(pairs(observer.events), [[133, 'down'], [133, 'up']], 'Target key never reaches the downstream hook; other keys do');
    assert.deepEqual(blocking.errors, []);
    await blocking.stop();
    observer.events.length = 0;
    await inject();
    await until(() => pairs(observer.events).length >= 4);
    assert.deepEqual(pairs(observer.events), [[135, 'down'], [135, 'up'], [133, 'down'], [133, 'up']]);
    assert.deepEqual(observer.errors, []);
  });

test('keyboard bridge exits and removes suppression when its Node owner dies',
  { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    const owner = fork(fileURLToPath(new URL('./keyboard-test-owner.ts', import.meta.url)), [], {
      execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    t.after(() => { owner.kill(); });
    const errors: string[] = [];
    let bridgePid = 0;
    owner.stderr?.setEncoding('utf8').on('data', data => errors.push(data));
    owner.on('error', error => errors.push(error.message));
    owner.on('message', (value: unknown) => {
      const message = value as { type: string; bridgePid?: number; message?: string };
      if (message.type === 'ready') bridgePid = message.bridgePid!;
      else errors.push(message.message || 'Owner failed');
    });
    await until(() => { if (errors.length) throw new Error(errors.join('\n')); return bridgePid > 0; }, 15000);
    owner.kill();
    await until(() => {
      try { process.kill(bridgePid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    });
  });
