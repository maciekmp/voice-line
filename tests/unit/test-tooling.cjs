const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestEnvironment } = require('../../scripts/lib/test-environment.cjs');
const { selectSuite } = require('../../scripts/run-tests.cjs');
const { deviceListingSucceeded } = require('../../scripts/diagnose-devices.cjs');

test('test environments isolate homes and remove production settings regardless of case', () => {
  const inherited = { Path: 'test-path', SystemRoot: 'test-system', FFPLAY_BIN: 'custom-player.exe',
    openai_api_key: 'secret', CODEX_ACCESS_TOKEN: 'token', CODEX_HOME: 'production',
    ChatGPT_Button_Data_Dir: 'production-data', whisper_threads: 'invalid',
    NODE_OPTIONS: '--env-file=.env', https_proxy: 'production-proxy' };
  const first = createTestEnvironment('unit', inherited);
  const second = createTestEnvironment('unit', inherited);
  try {
    assert.notEqual(first.directory, second.directory);
    assert.equal(first.env.Path, inherited.Path);
    assert.equal(first.env.SystemRoot, inherited.SystemRoot);
    assert.equal(first.env.FFPLAY_BIN, inherited.FFPLAY_BIN);
    for (const key of ['openai_api_key', 'CODEX_ACCESS_TOKEN', 'ChatGPT_Button_Data_Dir',
      'whisper_threads', 'NODE_OPTIONS', 'https_proxy']) assert.equal(first.env[key], undefined);
    assert.equal(path.dirname(first.env.CHATGPT_BUTTON_DATA_DIR), first.directory);
    assert.equal(path.dirname(first.env.CODEX_HOME), first.directory);
    assert.equal(first.env.CODEX_SQLITE_HOME, first.env.CODEX_HOME);
    assert.equal(first.env.NO_PROXY, '127.0.0.1,localhost,::1');
    fs.writeFileSync(path.join(first.directory, 'cleanup.txt'), 'fixture');
  } finally { first.cleanup(); second.cleanup(); }
  assert.equal(fs.existsSync(first.directory), false);
  assert.equal(fs.existsSync(second.directory), false);
  assert.equal(inherited.CODEX_HOME, 'production');
});

test('suite selection separates unit, external integrations and native tests', () => {
  const unit = selectSuite('unit');
  assert.ok(unit.files.length >= 11);
  assert.ok(unit.files.every(file => path.basename(path.dirname(file)) === 'unit'));
  const selected = selectSuite('unit', ['test-app-storage.ts', '--test-name-pattern', 'startup']);
  assert.equal(selected.files.length, 1);
  assert.deepEqual(selected.nodeOptions, ['--test-name-pattern', 'startup']);
  assert.deepEqual(selectSuite('integration').files.map(file => path.basename(file)),
    ['test-speaker.ts', 'test-storage-wire.ts', 'test-realtime-wire.ts']);
  assert.equal(selectSuite('desktop').group, 'desktop');
  assert.equal(selectSuite('keyboard').group, 'keyboard');
  for (const args of [['unknown'], ['unit', ['../../.env']], ['unit', ['--env-file=.env']],
    ['unit', ['--test-name-pattern']], ['integration', ['--test-name-pattern=foo']], ['desktop', ['unexpected']]]) {
    assert.throws(() => selectSuite(...args));
  }
});

test('desktop environments keep captures separate from disposable application data', () => {
  const environment = createTestEnvironment('desktop', {});
  try {
    assert.equal(environment.env.VOICE_LINE_TEST_OUTPUT_DIR, environment.outputDirectory);
    assert.match(path.basename(environment.outputDirectory), /^desktop-/);
    assert.equal(path.basename(path.dirname(environment.outputDirectory)), 'test-results');
    assert.notEqual(environment.outputDirectory, environment.env.CHATGPT_BUTTON_DATA_DIR);
  } finally { environment.cleanup(); }
});

test('device enumeration recognizes FFmpeg listings while preserving genuine failures', () => {
  assert.equal(deviceListingSucceeded('[dshow @ 000001] "Microphone (USB)" (audio)\nError opening input: Immediate exit requested'), true);
  assert.equal(deviceListingSucceeded('[dshow @ 000001] DirectShow audio devices'), true);
  assert.equal(deviceListingSucceeded('Unknown input format: dshow'), false);
  assert.equal(deviceListingSucceeded('ffmpeg: command not found'), false);
});
