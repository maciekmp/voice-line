import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightCode } from '../../electron/code-highlight.js';

test('highlighting preserves whitespace, HTML, Unicode and unfinished streamed blocks', () => {
  for (const language of ['js', 'ts', 'python', 'json', 'sh', 'pwsh', 'sql', '', 'html', 'constructor', '__proto__']) {
    for (const text of ['', '\tconst x = "<script>żółć</script>";\r\n// true 42\n', '/* unfinished', '"unfinished', '```']) {
      assert.equal(highlightCode(text, language).map(part => part.text).join(''), text);
    }
  }
});

test('strings and comments protect their contents from further highlighting', () => {
  const tokens = highlightCode('const x = "// true 42"; /* false 12 */\nreturn 3;', 'JS');
  assert.deepEqual(tokens.filter(part => part.type), [
    { text: 'const', type: 'keyword' },
    { text: '"// true 42"', type: 'string' },
    { text: '/* false 12 */', type: 'comment' },
    { text: 'return', type: 'keyword' },
    { text: '3', type: 'number' },
  ]);
});

test('language rules handle Python triples, SQL case and shell comments', () => {
  assert.deepEqual(highlightCode('"""if # 12\ntext"""', 'py'), [{ text: '"""if # 12\ntext"""', type: 'string' }]);
  assert.deepEqual(highlightCode('SELECT', 'sql'), [{ text: 'SELECT', type: 'keyword' }]);
  assert.deepEqual(highlightCode('# comment', 'bash'), [{ text: '# comment', type: 'comment' }]);
  assert.deepEqual(highlightCode('// text', 'json'), [{ text: '// text', type: '' }]);
  assert.deepEqual(highlightCode('const', 'text'), [{ text: 'const', type: '' }]);
  const large = 'const '.repeat(20_000);
  assert.deepEqual(highlightCode(large, 'js'), [{ text: large, type: '' }]);
});
