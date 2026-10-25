import { renderAnswer } from './answer-renderer.js';
import { renderImages } from './image-renderer.js';
import { renderInputImages } from './input-images.js';
import { decorateNotice, setMessageIcon, setQuestionIcon } from './message-icons.js';

/** @typedef {import('../src/conversation-contract.ts').ConversationExchange} Exchange */
/** @param {Exchange} a @param {Exchange} b @param {'images' | 'inputImages'} [field] */
function sameImages(a, b, field = 'images') {
  const left = a[field] || [], right = b[field] || [];
  return left.length === right.length && left.every((image, i) => image.id === right[i].id && image.alt === right[i].alt);
}
/** @param {Exchange} a @param {Exchange} b */
function unchanged(a, b) {
  if (a.questionSource !== b.questionSource) return false;
  if (a.id !== undefined && a.revision !== undefined && b.id !== undefined && b.revision !== undefined) return a.revision === b.revision;
  // Compatibility for synthetic previews and older callers without identity.
  return a.question === b.question && a.answer === b.answer && a.interrupted === b.interrupted && sameImages(a, b) && sameImages(a, b, 'inputImages');
}

/** @param {HTMLElement} container @param {{onSelect?: (image: import('../src/conversation-contract.ts').GeneratedImage) => void}} [options] */
export function createHistoryRenderer(container, { onSelect } = {}) {
  /** @type {Map<string, {node: HTMLElement, question: HTMLElement, answer: HTMLElement, attachments: HTMLElement, inputs: HTMLElement, exchange: Exchange, disposeImages: () => void, disposeInputs: () => void}>} */
  const rows = new Map();
  /** @type {string | null | undefined} */
  let previousId;
  /** @type {number | undefined} */
  let previousRevision;
  let previousLength = -1;
  const stats = { created: 0, updated: 0, removed: 0 };
  return {
    /** @param {Exchange[]} exchanges @param {{conversationId?: string | null, revision?: number}} [version] */
    update(exchanges, version = {}) {
      if (version.revision !== undefined && version.conversationId === previousId
        && version.revision === previousRevision && exchanges.length === previousLength) return;
      previousId = version.conversationId;
      previousRevision = version.revision;
      previousLength = exchanges.length;
      const retained = new Set();
      let cursor = container.firstElementChild;
      for (const [index, exchange] of exchanges.entries()) {
        const key = `${version.conversationId ?? ''}:${exchange.id ?? `position:${index}`}`;
        retained.add(key);
        let row = rows.get(key);
        if (!row) {
          const node = document.createElement('article'); node.className = 'exchange';
          const question = document.createElement('p'); question.className = 'previous-question'; question.setAttribute('aria-label', 'Twoje pytanie');
          const answer = document.createElement('div'); answer.className = 'previous-answer'; answer.setAttribute('aria-label', 'Odpowiedź');
          const attachments = document.createElement('div');
          const inputs = document.createElement('div'); inputs.className = 'input-attachments';
          const questionRow = document.createElement('div'); questionRow.className = 'previous-question';
          question.className = '';
          questionRow.append(question); setQuestionIcon(questionRow, exchange.questionSource);
          const answerRow = document.createElement('div'); answerRow.className = 'previous-answer';
          answerRow.append(answer); setMessageIcon(answerRow, 'answer');
          attachments.className = 'message-attachments';
          question.textContent = exchange.question;
          renderAnswer(answer, exchange.answer);
          node.append(questionRow, inputs, answerRow, attachments);
          node.dataset.interrupted = String(!!exchange.interrupted);
          row = { node, question, answer, attachments, inputs, exchange,
            disposeImages: renderImages(attachments, exchange.images, { lazy: true, onSelect }),
            disposeInputs: renderInputImages(inputs, exchange.inputImages, { lazy: true, onSelect }) };
          rows.set(key, row); stats.created++;
        } else if (!unchanged(row.exchange, exchange)) {
          setQuestionIcon(/** @type {HTMLElement} */ (row.question.parentElement), exchange.questionSource);
          if (row.exchange.question !== exchange.question) row.question.textContent = exchange.question;
          if (row.exchange.answer !== exchange.answer) renderAnswer(row.answer, exchange.answer);
          if (!sameImages(row.exchange, exchange)) {
            row.disposeImages();
            row.disposeImages = renderImages(row.attachments, exchange.images, { lazy: true, onSelect });
          }
          if (!sameImages(row.exchange, exchange, 'inputImages')) {
            row.disposeInputs();
            row.disposeInputs = renderInputImages(row.inputs, exchange.inputImages, { lazy: true, onSelect });
          }
          row.exchange = exchange; stats.updated++;
        }
        let interruption = row.node.querySelector('.interrupted-status');
        if (exchange.interrupted && !interruption) {
          interruption = document.createElement('p'); interruption.className = 'interrupted-status';
          interruption.textContent = 'Odpowiedź przerwana'; decorateNotice(/** @type {HTMLElement} */ (interruption), 'info'); row.node.append(interruption);
        } else if (!exchange.interrupted) interruption?.remove();
        if (row.node === cursor) cursor = cursor.nextElementSibling;
        else container.insertBefore(row.node, cursor);
      }
      for (const [key, row] of rows) if (!retained.has(key)) {
        row.disposeImages(); row.disposeInputs(); row.node.remove(); rows.delete(key); stats.removed++;
      }
    },
    get stats() { return { ...stats, rows: rows.size }; },
    dispose() {
      for (const row of rows.values()) { row.disposeImages(); row.disposeInputs(); row.node.remove(); }
      rows.clear(); previousLength = -1;
    },
  };
}
