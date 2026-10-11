import { renderAnswer } from './answer-renderer.js';
import { renderImages, refreshImageVisibility } from './image-renderer.js';
import { createHistoryRenderer } from './history-renderer.js';
import { decorateNotice, setMessageIcon, setQuestionIcon } from './message-icons.js';

/** @typedef {{pin: HTMLButtonElement, previous: HTMLButtonElement, retry: HTMLButtonElement,
 * composer: HTMLFormElement, message: HTMLTextAreaElement, history: HTMLElement, status: HTMLElement,
 * error: HTMLElement, empty: HTMLElement, question: HTMLElement, answer: HTMLElement, images: HTMLElement,
 * 'question-block': HTMLElement, 'answer-block': HTMLElement}} Elements */
/** @template {keyof Elements} K @param {K} id @returns {Elements[K]} */
const get = id => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing conversation element: ${id}`);
  return /** @type {Elements[K]} */ (element);
};
const main = (() => {
  const element = document.querySelector('main');
  if (!element) throw new Error('Missing conversation main');
  return element;
})();
/** @type {Partial<import('../src/desktop-contract.ts').DesktopVoice>} */
let snapshot = { state: 'starting', ready: false };
let pending = false;
let draftRevision = 0;
let composing = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let resizeFrame;
let scrollToLatest = false;
const historyRenderer = createHistoryRenderer(get('history'));
const statusText = decorateNotice(get('status'), 'info');
const errorText = decorateNotice(get('error'), 'error');
decorateNotice(get('empty'), 'info');
setMessageIcon(get('answer-block'), 'answer');
function reportComposerFocus() {
  window.orbDesktop.composerFocus(document.hasFocus() && document.activeElement === get('message') && !get('composer').hidden);
}
get('message').addEventListener('focus', reportComposerFocus);
get('message').addEventListener('blur', reportComposerFocus);
window.addEventListener('focus', reportComposerFocus);
window.addEventListener('blur', () => window.orbDesktop.composerFocus(false));
/** @type {string | undefined} */
let renderedAnswer;
let renderedImages = '';
function reportSize() {
  clearTimeout(resizeFrame);
  resizeFrame = setTimeout(() => window.orbDesktop.resize({
    height: Math.ceil(main.getBoundingClientRect().height + (get('composer').hidden ? 0 : get('composer').offsetHeight)),
    mode: panelMode(),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }), 0);
}
const sizeObserver = new ResizeObserver(reportSize);
sizeObserver.observe(main);
sizeObserver.observe(get('composer'));
get('pin').addEventListener('click', () => window.orbDesktop.command('pin'));
get('previous').addEventListener('click', () => {
  if (!get('previous').disabled) window.orbDesktop.command('previous');
});
window.orbDesktop.onPinned(pinned => {
  get('pin').setAttribute('aria-pressed', String(pinned));
  get('pin').setAttribute('aria-label', pinned ? 'Odepnij popup' : 'Przypnij popup');
  get('pin').title = pinned ? 'Odepnij popup' : 'Przypnij popup';
});
window.orbDesktop.onResizing(resizing => {
  document.documentElement.dataset.resizing = String(resizing);
  if (!resizing && scrollToLatest && document.body.dataset.mode === 'chat') {
    scrollToLatest = false;
    scrollTo(0, document.documentElement.scrollHeight);
  }
});
function panelMode() {
  const mode = document.body.dataset.mode;
  return mode === 'chat' || mode === 'compose' || mode === 'compact' ? mode : 'peek';
}
const busy = () => ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(snapshot.state || 'starting');
const canSubmit = () => !pending && !busy() && snapshot.ready && Boolean(get('message').value.trim());
function updateComposer() {
  get('composer').setAttribute('aria-busy', String(pending || busy()));
  get('previous').disabled = pending || busy() || !snapshot.ready || !snapshot.canRestorePrevious;
  get('previous').title = !snapshot.canRestorePrevious ? 'Brak poprzedniej rozmowy'
    : pending || busy() || !snapshot.ready ? 'Poczekaj na zakończenie odpowiedzi'
      : 'Wróć do poprzedniej rozmowy';
}
function resizeMessage() {
  const minimum = document.body.dataset.mode === 'compose' ? 64 : 40;
  get('message').style.height = `${minimum}px`;
  get('message').style.height = `${Math.min(140, Math.max(minimum, get('message').scrollHeight))}px`;
}
document.documentElement.addEventListener('pointerenter', () => window.orbDesktop.hover(true));
document.documentElement.addEventListener('pointerleave', () => window.orbDesktop.hover(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) window.orbDesktop.command('hide');
});
window.orbDesktop.onClearDraft(() => {
  draftRevision++; get('message').value = ''; resizeMessage(); updateComposer();
});
window.orbDesktop.onMode(mode => {
  const changed = document.body.dataset.mode !== mode;
  if (changed) document.documentElement.dataset.resizing = 'true';
  document.body.dataset.mode = mode;
  const editable = mode === 'chat' || mode === 'compose' || mode === 'compact';
  get('composer').hidden = !editable;
  get('history').hidden = mode !== 'chat' || !(snapshot.history?.length);
  refreshImageVisibility();
  if (mode === 'chat' && changed) scrollToLatest = true;
  if (!editable) get('message').blur();
  if (editable) {
    resizeMessage();
    get('message').focus({ preventScroll: true });
  }
  if (mode === 'compose') scrollTo(0, 0);
  reportSize();
});
const labels = {
  starting: 'Uruchamiam usługi…', idle: '', listening: 'Słucham…',
  transcribing: 'Rozpoznaję mowę…', thinking: 'Codex przygotowuje odpowiedź…',
  'preparing-speech': 'Przygotowuję głos…', speaking: 'Odczytuję odpowiedź…', error: '',
};
window.orbDesktop.onVoice(value => {
  const nearBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 32;
  snapshot = value;
  const history = value.history || [];
  historyRenderer.update(history, { conversationId: value.conversation?.id, revision: value.conversation?.revision });
  get('history').hidden = document.body.dataset.mode !== 'chat' || !history.length;
  refreshImageVisibility();
  if (nearBottom) scrollToLatest = true;
  statusText.textContent = value.interrupted ? 'Odpowiedź przerwana' : value.state === 'thinking' && value.generatingImage ? 'Generuję obraz…' : labels[value.state] || '';
  get('status').hidden = (!value.interrupted && Boolean(value.answer) && !['thinking', 'starting'].includes(value.state)) || !get('status').textContent;
  get('error').hidden = !value.message;
  errorText.textContent = value.message || '';
  setQuestionIcon(get('question-block'), value.questionSource);
  get('retry').hidden = value.state !== 'error' || value.ready;
  for (const key of /** @type {const} */ (['question', 'answer'])) {
    if (key === 'answer') {
      const answer = value.answer || '';
      if (answer !== renderedAnswer) { renderAnswer(get(key), answer); renderedAnswer = answer; }
    } else get(key).textContent = value[key] || '';
    get(`${key}-block`).hidden = !value[key];
  }
  get('empty').hidden = Boolean(value.question || value.answer || value.message || value.state !== 'idle');
  const imagesKey = JSON.stringify(value.images || []);
  if (imagesKey !== renderedImages) { renderedImages = imagesKey; renderImages(get('images'), value.images); }
  updateComposer();
  reportSize();
});
get('message').addEventListener('input', () => {
  draftRevision++;
  resizeMessage();
  updateComposer();
});
get('message').addEventListener('compositionstart', () => { composing = true; });
get('message').addEventListener('compositionend', () => { composing = false; });
get('message').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composing || event.keyCode === 229) return;
  event.preventDefault();
  get('composer').requestSubmit();
});
get('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if (composing || !canSubmit()) return;
  const text = get('message').value.trim();
  const revision = draftRevision;
  pending = true;
  updateComposer();
  try {
    if (await window.orbDesktop.text(text)) {
      if (revision !== draftRevision) return;
      get('message').value = '';
      resizeMessage();
    } else {
      errorText.textContent = 'Nie wysłano wiadomości. Poczekaj na gotowość usług i spróbuj ponownie.';
      get('error').hidden = false;
    }
  } catch {
    errorText.textContent = 'Nie wysłano wiadomości. Spróbuj ponownie.';
    get('error').hidden = false;
  } finally { pending = false; updateComposer(); }
});
get('retry').addEventListener('click', () => window.orbDesktop.command('retry'));
window.orbDesktop.ready();
