const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const source = readFileSync(path.join(__dirname, '../electron/orb-main.cjs'), 'utf8');
  const registration = source.match(/ipcMain\.handle\('voice:copy-code',[\s\S]*?\n}\);/)[0];
  let handler;
  const writes = [];
  const context = {
    ipcMain: { handle(name, callback) { assert.equal(name, 'voice:copy-code'); handler = callback; } },
    panelWindow: { webContents: {}, isDestroyed: () => false },
    exitStarted: false,
    clipboard: { writeText(text) { writes.push(text); } },
  };
  vm.runInNewContext(registration, context);
  return { context, writes, copy: text => handler({ sender: context.panelWindow.webContents }, text), handler };
}

test('copies exact multiline code through native clipboard without focus requirements', () => {
  const { copy, writes } = setup();
  const code = '\tconsole.log("<b>Zażółć</b>");\r\n  next();\n';
  assert.equal(copy(code), true);
  assert.deepEqual(writes, [code]);
});

test('rejects foreign senders, invalid input, closed windows and shutdown', () => {
  const { context, copy, writes, handler } = setup();
  assert.equal(handler({ sender: {} }, 'code'), false);
  for (const value of [null, undefined, 42, { text: 'code' }]) assert.equal(copy(value), false);
  context.exitStarted = true;
  assert.equal(copy('code'), false);
  context.exitStarted = false;
  context.panelWindow.isDestroyed = () => true;
  assert.equal(copy('code'), false);
  context.panelWindow = null;
  assert.equal(handler({ sender: {} }, 'code'), false);
  assert.deepEqual(writes, []);
});

test('native clipboard failure is reported to the renderer', () => {
  const { context, copy } = setup();
  context.clipboard.writeText = () => { throw new Error('Unavailable'); };
  assert.equal(copy('code'), false);
});

test('preload exposes only the copy command and returns its result', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'orbDesktop'); bridge = api; } },
        ipcRenderer: { invoke(channel, text) { calls.push([channel, text]); return Promise.resolve(true); } },
      };
    },
  });
  assert.equal(await bridge.copyCode('  code\n'), true);
  assert.deepEqual(calls, [['voice:copy-code', '  code\n']]);
});
