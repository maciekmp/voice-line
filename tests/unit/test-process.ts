import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { launch, collect } from '../../src/process.ts';

test('pre-cancelled collection handles a later missing-executable error without crashing', async () => {
  const child = launch(join(tmpdir(), `voice-line-missing-${randomUUID()}.exe`), []);
  // Do not attach an error listener in the fixture: collect must own that event
  // even after it has already reported cancellation to the caller.
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  await assert.rejects(collect(child, AbortSignal.abort()), /Cancelled/);
  await closed;
});

test('collection preserves stdout, stderr and the exit code', async () => {
  const child = launch(process.execPath, ['-e', 'process.stdout.write("result"); process.stderr.write("diagnostic"); process.exitCode = 3;']);
  assert.deepEqual(await collect(child), { stdout: 'result', stderr: 'diagnostic', code: 3 });
});

test('cancellation terminates a running child and rejects collection', async () => {
  const child = launch(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);']);
  const ready = once(child.stdout, 'data');
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const controller = new AbortController();
  const result = collect(child, controller.signal);
  await ready;
  const rejected = assert.rejects(result, /Cancelled/);
  controller.abort();
  await rejected;
  await closed;
});

test('native launch preserves arguments containing whitespace and shell metacharacters', async () => {
  const args = ['path with spaces', 'value & echo unexpected', 'quote"here', '%PATH%', 'a|b', 'a>b', 'line\nbreak'];
  const result = await collect(launch(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('npm Codex shim resolves to JavaScript without reparsing arguments through cmd', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'node_modules', '@openai', 'codex', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(directory, 'codex.cmd'), '@echo This wrapper must not execute\r\n');
  await writeFile(join(bin, 'codex.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const args = ['path with spaces', 'value & echo unexpected', 'quote"here', '%PATH%', 'a|b', 'a>b'];
  const result = await collect(launch(join(directory, 'codex.cmd'), args));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('unrecognized batch launchers fail without starting a shell', { skip: process.platform !== 'win32' }, () => {
  for (const command of ['unknown-wrapper.cmd', 'unknown-wrapper.BAT']) {
    assert.throws(() => launch(command, ['& echo unexpected']), /Cannot safely launch a Windows batch script/);
  }
});

test('explicit Codex shim paths fail instead of using an unrelated installation from PATH', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = join(directory, 'codex.cmd');
  await writeFile(wrapper, '@echo Unsupported wrapper\r\n');
  assert.throws(() => launch(wrapper, ['--version']), /Cannot safely launch a Windows batch script/);
  assert.throws(() => launch(join(directory, 'missing', 'codex.cmd'), ['--version']), /Cannot safely launch a Windows batch script/);
});
