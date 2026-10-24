// Deliberately small lexical highlighter, not a full language parser.
const scriptWords = 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield';
const pythonWords = 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield';
/** @type {Record<string, { comments: string, words: string, templates?: boolean, triples?: boolean, insensitive?: boolean }>} */
const languages = {
  javascript: { comments: '//[^\\r\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)', words: scriptWords, templates: true },
  typescript: { comments: '//[^\\r\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)', words: `${scriptWords} abstract any as boolean declare enum implements interface keyof never number private protected public readonly string type unknown`, templates: true },
  python: { comments: '#[^\\r\\n]*', words: pythonWords, triples: true },
  json: { comments: '(?!)', words: 'true false null' },
  bash: { comments: '#[^\\r\\n]*', words: 'if then else elif fi for in do done while case esac function export local return exit' },
  powershell: { comments: '#[^\\r\\n]*|<#[\\s\\S]*?(?:#>|$)', words: 'begin break catch class continue do else elseif end false finally for foreach function if in null param process return switch throw true try until while', insensitive: true },
  sql: { comments: '--[^\\r\\n]*|/\\*[\\s\\S]*?(?:\\*/|$)', words: 'select from where insert into values update set delete create table drop alter join inner left right outer on as and or not null true false is in like order by group having limit distinct union all case when then else end', insensitive: true },
};
/** @type {Record<string, string>} */
const aliases = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', ps1: 'powershell', pwsh: 'powershell' };

/** @param {string} text @param {string} language
 * @returns {{ text: string, type: string }[]} */
export function highlightCode(text, language) {
  const name = language.toLowerCase();
  const canonical = Object.hasOwn(aliases, name) ? aliases[name] : name;
  const config = Object.hasOwn(languages, canonical) ? languages[canonical] : undefined;
  // Bound the work for very large blocks; always preserve their contents.
  if (!config || text.length > 100_000) return [{ text, type: '' }];
  const strings = [
    ...(config.triples ? ['"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)"] : []),
    '"(?:\\\\[\\s\\S]|[^"\\\\\\r\\n])*(?:"|$)',
    "'(?:\\\\[\\s\\S]|[^'\\\\\\r\\n])*(?:'|$)",
    ...(config.templates ? ['`(?:\\\\[\\s\\S]|[^`\\\\])*(?:`|$)'] : []),
  ].join('|');
  const pattern = new RegExp(`(${config.comments})|(${strings})|(\\b(?:${config.words.split(' ').join('|')})\\b)|(\\b(?:0x[\\da-f]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b)`, config.insensitive ? 'gi' : 'g');
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) parts.push({ text: text.slice(cursor, index), type: '' });
    parts.push({ text: match[0], type: match[1] !== undefined ? 'comment' : match[2] !== undefined ? 'string' : match[3] !== undefined ? 'keyword' : 'number' });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), type: '' });
  return parts;
}
