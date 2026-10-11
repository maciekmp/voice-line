const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { loadVisualPreferences, saveVisualPreferences, visualIndicatorMenu } = require('../../electron/visual-preferences.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'voice-visual-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, filename: join(root, 'settings.json') };
}

test('each effect survives a fresh read, with preview stored independently', t => {
  const { root, filename } = fixture(t);
  assert.deepEqual(loadVisualPreferences(filename), { indicator: 'bars' });
  for (const indicator of ['bars', 'orb', 'glow', 'waves']) {
    saveVisualPreferences(filename, indicator);
    assert.deepEqual(loadVisualPreferences(filename), { indicator });
  }
  saveVisualPreferences(join(root, 'preview.json'), 'glow');
  assert.deepEqual(loadVisualPreferences(filename), { indicator: 'waves' });
});

test('unsupported or malformed preferences fall back to bars', t => {
  const { filename } = fixture(t);
  for (const value of ['null', '{"version":2,"indicator":"waves"}', '{"version":1,"indicator":"unknown"}', '{"indicator":"orb"}', '{broken']) {
    fs.writeFileSync(filename, value);
    assert.deepEqual(loadVisualPreferences(filename), { indicator: 'bars' });
  }
  assert.throws(() => saveVisualPreferences(filename, 'unknown'), /Unknown/);
});

test('a failed atomic save preserves the previously selected effect', t => {
  const { root, filename } = fixture(t);
  saveVisualPreferences(filename, 'orb');
  const denied = { ...fs, renameSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.throws(() => saveVisualPreferences(filename, 'waves', denied), /denied/);
  assert.deepEqual(loadVisualPreferences(filename), { indicator: 'orb' });
  assert.deepEqual(fs.readdirSync(root), ['settings.json']);
});

test('menu contains only four choices and routes selection to persistence', () => {
  let selected;
  const menu = visualIndicatorMenu('waves', value => { selected = value; });
  const choices = menu.filter(item => item.type === 'radio');
  assert.equal(menu.length, 4);
  assert.equal(choices.length, 4);
  assert.deepEqual(choices.filter(item => item.checked).map(item => item.label), ['Fale']);
  choices[1].click();
  assert.equal(selected, 'orb');
});
