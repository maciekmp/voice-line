// Captured from conversation.js before the incremental-history refactor.
// Kept as a benchmark reference, never loaded by production.
import { renderAnswer } from '../../electron/answer-renderer.js';
import { renderImages } from '../../electron/image-renderer.js';
export function createBaselineHistoryRenderer(container) {
 let renderedHistory = '';
 return { update(history) {
  const historyKey = JSON.stringify(history);
  if (historyKey !== renderedHistory) {
    renderedHistory = historyKey;
    container.replaceChildren(...history.map(exchange => {
      const article = document.createElement('article');
      article.className = 'exchange';
      for (const key of ['question', 'answer']) {
        const p = document.createElement(key === 'answer' ? 'div' : 'p');
        p.className = `previous-${key}`;
        p.setAttribute('aria-label', key === 'question' ? 'Twoje pytanie' : 'Odpowiedź');
        if (key === 'answer') renderAnswer(p, exchange[key] || '');
        else p.textContent = exchange[key] || '';
        article.append(p);
      }
      const attachments = document.createElement('div');
      renderImages(attachments, exchange.images);
      article.append(attachments);
      return article;
    }));
  }

 } };
}
