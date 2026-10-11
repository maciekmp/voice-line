// Lucide outlines, stored locally; presentation never depends on a network request.
const circle = ['circle', { cx: '12', cy: '12', r: '10' }];
const shapes = {
  info: [circle, ['path', { d: 'M12 16v-4m0-4h.01' }]],
  mic: [['path', { d: 'M12 19v3m7-12v2a7 7 0 0 1-14 0v-2' }], ['rect', { width: '6', height: '13', x: '9', y: '2', rx: '3' }]],
  keyboard: [['path', { d: 'M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10m-9-4h.01' }], ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }]],
  answer: [['path', { d: 'M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092a10 10 0 1 0-4.777-4.719' }]],
  error: [circle, ['path', { d: 'M12 8v4m0 4h.01' }]],
  question: [circle, ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.08 4h.01' }]],
};
/** @typedef {keyof typeof shapes} IconType */
/** @param {HTMLElement} row @param {IconType} type */
export function setMessageIcon(row, type) {
  row.classList.add('message-row');
  if (row.dataset.messageIcon === type) return;
  row.querySelector(':scope > .message-icon')?.remove();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ class: 'message-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value);
  for (const shape of shapes[type]) {
    const [tag, attrs] = /** @type {[string, Record<string, string>]} */ (shape);
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  row.prepend(svg);
  row.dataset.messageIcon = type;
}
/** @param {HTMLElement} row @param {import('../src/conversation-contract.ts').QuestionSource | undefined} source */
export function setQuestionIcon(row, source) {
  setMessageIcon(row, source === 'voice' ? 'mic' : source === 'text' ? 'keyboard' : 'question');
  row.setAttribute('aria-label', source === 'voice' ? 'Twoje pytanie mówione' : source === 'text' ? 'Twoje pytanie pisane' : 'Twoje pytanie');
}
/** @param {HTMLElement} row @param {IconType} type */
export function decorateNotice(row, type) {
  const content = document.createElement('span');
  content.className = 'message-content';
  content.append(...Array.from(row.childNodes));
  row.append(content);
  setMessageIcon(row, type);
  return content;
}
