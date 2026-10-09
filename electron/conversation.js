import { renderAnswer } from './answer-renderer.js';

const get = id => document.getElementById(id);
let snapshot = { state: 'starting', ready: false };
let pending = false;
let composing = false;
let resizeFrame;
let scrollToLatest = false;
let renderedHistory = '';
let renderedAnswer;
function reportSize() {
  clearTimeout(resizeFrame);
  resizeFrame = setTimeout(() => window.orbDesktop.resize({
    height: Math.ceil(document.querySelector('main').getBoundingClientRect().height + (get('composer').hidden ? 0 : get('composer').offsetHeight)),
    mode: document.body.dataset.mode,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }), 0);
}
const sizeObserver = new ResizeObserver(reportSize);
sizeObserver.observe(document.querySelector('main'));
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
const busy = () => ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(snapshot.state);
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
window.orbDesktop.onMode(mode => {
  const changed = document.body.dataset.mode !== mode;
  if (changed) document.documentElement.dataset.resizing = 'true';
  document.body.dataset.mode = mode;
  const editable = mode === 'chat' || mode === 'compose';
  get('composer').hidden = !editable;
  get('history').hidden = mode !== 'chat' || !(snapshot.history?.length);
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
  transcribing: 'Rozpoznaję mowę…', thinking: '',
  'preparing-speech': 'Przygotowuję głos…', speaking: 'Odczytuję odpowiedź…', error: '',
};
window.orbDesktop.onVoice(value => {
  const nearBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 32;
  snapshot = value;
  const history = value.history || [];
  const historyKey = JSON.stringify(history);
  if (historyKey !== renderedHistory) {
    renderedHistory = historyKey;
    get('history').replaceChildren(...history.map(exchange => {
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
      return article;
    }));
  }
  get('history').hidden = document.body.dataset.mode !== 'chat' || !history.length;
  if (nearBottom) scrollToLatest = true;
  get('status').textContent = labels[value.state] || '';
  get('status').hidden = Boolean(value.answer) || !get('status').textContent;
  get('error').hidden = !value.message;
  get('error').textContent = value.message || '';
  get('retry').hidden = value.state !== 'error' || value.ready;
  for (const key of ['question', 'answer']) {
    if (key === 'answer') {
      const answer = value.answer || '';
      if (answer !== renderedAnswer) { renderAnswer(get(key), answer); renderedAnswer = answer; }
    } else get(key).textContent = value[key] || '';
    get(`${key}-block`).hidden = !value[key];
  }
  get('empty').hidden = Boolean(value.question || value.answer || value.message || value.state !== 'idle');
  updateComposer();
  reportSize();
});
get('message').addEventListener('input', () => {
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
  pending = true;
  updateComposer();
  try {
    if (await window.orbDesktop.text(text)) {
      get('message').value = '';
      resizeMessage();
    } else {
      get('error').textContent = 'Nie wysłano wiadomości. Poczekaj na gotowość usług i spróbuj ponownie.';
      get('error').hidden = false;
    }
  } catch {
    get('error').textContent = 'Nie wysłano wiadomości. Spróbuj ponownie.';
    get('error').hidden = false;
  } finally { pending = false; updateComposer(); }
});
get('retry').addEventListener('click', () => window.orbDesktop.command('retry'));
window.orbDesktop.ready();
