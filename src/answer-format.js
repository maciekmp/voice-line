// Shared by the conversation renderer and speech playback. Never interprets HTML.
export function splitAnswer(text) {
  const parts = [];
  let prose = '', code = '', fence = null;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const body = line.replace(/\r?\n$/, '');
    if (fence) {
      const close = body.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        parts.push({ type: 'code', text: code, language: fence.language });
        code = ''; fence = null;
      } else code += line;
      continue;
    }
    const open = body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      if (prose) parts.push({ type: 'text', text: prose });
      prose = '';
      fence = { marker: open[1][0], length: open[1].length, language: open[2].trim().split(/\s+/)[0] || '' };
    } else prose += line;
  }
  if (fence) parts.push({ type: 'code', text: code, language: fence.language });
  if (prose) parts.push({ type: 'text', text: prose });
  return parts;
}

export function splitInline(text) {
  const parts = [];
  const ticks = /`+/g;
  let cursor = 0, match;
  while ((match = ticks.exec(text))) {
    const endPattern = /`+/g;
    endPattern.lastIndex = ticks.lastIndex;
    let end;
    while ((end = endPattern.exec(text)) && end[0].length !== match[0].length) { /* Find a matching delimiter. */ }
    if (!end) continue;
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) });
    let code = text.slice(ticks.lastIndex, end.index).replace(/\r?\n/g, ' ');
    if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
    parts.push({ type: 'code', text: code });
    cursor = end.index + end[0].length;
    ticks.lastIndex = cursor;
  }
  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}

export function speechText(answer) {
  const parts = splitAnswer(answer);
  const prose = parts.filter(part => part.type === 'text').map(part => splitInline(part.text).map(item => item.text).join('')).join('\n').trim();
  return prose || (parts.some(part => part.type === 'code') ? 'Kod znajdziesz w oknie rozmowy.' : '');
}
