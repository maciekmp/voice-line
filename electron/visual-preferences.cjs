const fs = require('node:fs');
const { writeAtomicSync } = require('./atomic-file.cjs');

const indicators = ['bars', 'orb', 'glow', 'waves'];

function loadVisualPreferences(filename) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (value?.version === 1 && indicators.includes(value.indicator)) return { indicator: value.indicator };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Cannot read visual preferences:', error.message);
  }
  return { indicator: 'bars' };
}

function saveVisualPreferences(filename, indicator, filesystem = fs) {
  if (!indicators.includes(indicator)) throw new Error('Unknown audio indicator');
  writeAtomicSync(filename, JSON.stringify({ version: 1, indicator }, null, 2) + '\n', filesystem);
}

function visualIndicatorMenu(indicator, select) {
  const choice = (value, label) => ({ label, type: 'radio', checked: indicator === value, click: () => select(value) });
  return [
    choice('bars', 'Słupki'),
    choice('orb', 'Mini orb'),
    choice('glow', 'Podświetlenie'),
    choice('waves', 'Fale'),
  ];
}

module.exports = { loadVisualPreferences, saveVisualPreferences, visualIndicatorMenu };
