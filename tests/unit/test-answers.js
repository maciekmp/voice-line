import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAnswer, splitInline, speechText } from '../../electron/answer-format.js';

test('mixed answers preserve code, indentation, HTML and surrounding prose', () => {
  const code = 'if (ready) {\n\tconsole.log("<script>hello</script>");\n}\n';
  assert.deepEqual(splitAnswer('Przykład:\n```js\n' + code + '```\nGotowe.'), [
    { type: 'text', text: 'Przykład:\n' },
    { type: 'code', text: code, language: 'js' },
    { type: 'text', text: 'Gotowe.' },
  ]);
});

test('longer fences can contain shorter fences; tildes and CRLF are supported', () => {
  assert.deepEqual(splitAnswer('````md\r\n```js\r\nx\r\n```\r\n````\r\n~~~python\nprint(1)\n~~~'), [
    { type: 'code', language: 'md', text: '```js\r\nx\r\n```\r\n' },
    { type: 'code', language: 'python', text: 'print(1)\n' },
  ]);
});

test('unclosed and empty blocks stay usable without losing the final line', () => {
  assert.deepEqual(splitAnswer('```\nabc'), [{ type: 'code', text: 'abc', language: '' }]);
  assert.deepEqual(splitAnswer('```\n```'), [{ type: 'code', text: '', language: '' }]);
  assert.deepEqual(splitAnswer('Zwykły tekst'), [{ type: 'text', text: 'Zwykły tekst' }]);
  assert.deepEqual(splitAnswer(''), []);
});

test('inline code supports matching backticks and preserves unmatched delimiters', () => {
  assert.deepEqual(splitInline('Użyj `npm start` i ``a`b``.'), [
    { type: 'text', text: 'Użyj ' }, { type: 'code', text: 'npm start' },
    { type: 'text', text: ' i ' }, { type: 'code', text: 'a`b' },
    { type: 'text', text: '.' },
  ]);
  assert.deepEqual(splitInline('A `bez końca'), [{ type: 'text', text: 'A `bez końca' }]);
});

test('speech skips fenced code and removes inline delimiters', () => {
  assert.equal(speechText('Użyj `node`.\n```js\nsecret();\n```\nGotowe.'), 'Użyj node.\n\nGotowe.');
  assert.equal(speechText('```js\nsecret();\n```'), 'Kod znajdziesz w oknie rozmowy.');
  assert.equal(speechText('Bez kodu.'), 'Bez kodu.');
});
