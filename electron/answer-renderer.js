import { splitAnswer, splitInline } from './answer-format.js';

/** @param {HTMLElement} container @param {string} answer */
export function renderAnswer(container, answer) {
  const fragment = document.createDocumentFragment();
  for (const part of splitAnswer(answer)) {
    if (part.type === 'text') {
      const p = document.createElement('p');
      for (const inline of splitInline(part.text)) {
        const node = inline.type === 'code' ? document.createElement('code') : document.createTextNode(inline.text);
        if (inline.type === 'code') node.textContent = inline.text;
        p.append(node);
      }
      fragment.append(p);
      continue;
    }
    const block = document.createElement('section');
    block.className = 'code-block';
    const copy = document.createElement('button');
    copy.className = 'code-copy';
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Kopiuj kod');
    copy.title = 'Kopiuj kod';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    // Lucide copy, matching the popup's pin icon.
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const [name, value] of Object.entries({ width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' })) rect.setAttribute(name, value);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2');
    svg.append(rect, path);
    copy.append(svg);
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    check.setAttribute('d', 'M20 6 9 17l-5-5');
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let resetTimer;
    const resetCopy = () => {
      svg.replaceChildren(rect, path);
      delete copy.dataset.copied;
      copy.setAttribute('aria-label', 'Kopiuj kod');
      copy.title = 'Kopiuj kod';
    };
    const feedback = document.createElement('span');
    feedback.className = 'code-feedback';
    feedback.setAttribute('role', 'status');
    copy.addEventListener('click', async () => {
      clearTimeout(resetTimer);
      resetCopy();
      copy.disabled = true;
      feedback.className = 'code-feedback';
      feedback.textContent = '';
      try {
        if (!await window.voiceDesktop.copyCode(part.text)) throw new Error('Clipboard write failed');
        svg.replaceChildren(check);
        copy.dataset.copied = 'true';
        copy.setAttribute('aria-label', 'Skopiowano kod');
        copy.title = 'Skopiowano kod';
        feedback.className = 'sr-only';
        feedback.textContent = 'Skopiowano';
        resetTimer = setTimeout(resetCopy, 1500);
      } catch {
        feedback.textContent = 'Nie skopiowano. Zaznacz kod i naciśnij Ctrl+C.';
      } finally { copy.disabled = false; }
    });
    const pre = document.createElement('pre');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', part.language ? `Kod: ${part.language}` : 'Kod');
    const code = document.createElement('code');
    code.textContent = part.text;
    pre.append(code);
    block.append(copy, pre, feedback);
    fragment.append(block);
  }
  container.replaceChildren(fragment);
}
