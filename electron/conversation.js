import { renderAnswer } from './answer-renderer.js';
import { renderImages, refreshImageVisibility, imagePreviewCache } from './image-renderer.js';
import { createHistoryRenderer } from './history-renderer.js';
import { AudioIndicator } from './audio-indicator.js';
import { decorateNotice, setMessageIcon, setQuestionIcon } from './message-icons.js';
import { renderInputImages } from './input-images.js';

/** @typedef {{pin: HTMLButtonElement, previous: HTMLButtonElement, retry: HTMLButtonElement,
 * composer: HTMLFormElement, message: HTMLTextAreaElement, 'composer-status': HTMLElement, history: HTMLElement, status: HTMLElement,
 * error: HTMLElement, empty: HTMLElement, question: HTMLElement, answer: HTMLElement, images: HTMLElement,
 * 'question-block': HTMLElement, 'answer-block': HTMLElement, 'image-attachment': HTMLElement,
 * 'attachment-preview': HTMLImageElement, 'remove-attachment': HTMLButtonElement,
 * 'add-image': HTMLButtonElement, 'capture-screen': HTMLButtonElement, 'attachment-progress': HTMLElement,
 * 'input-images': HTMLElement}} Elements */
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
const header = document.getElementById('panel-header');
const panel = document.getElementById('panel');
if (!panel) throw new Error('Missing conversation panel');
const content = document.getElementById('conversation-content');
if (!content) throw new Error('Missing conversation content');
const audioSlot = document.getElementById('audio-indicator');
const modeLabel = document.getElementById('voice-mode');
const audioGlow = document.getElementById('audio-glow');
const audioWaves = document.getElementById('audio-waves');
if (!header || !audioSlot || !modeLabel || !audioGlow || !audioWaves) throw new Error('Missing audio feedback elements');
const audioIndicator = new AudioIndicator(audioSlot, modeLabel, audioGlow, audioWaves);
window.voiceDesktop.onLevel(level => audioIndicator.audio(level));
window.voiceDesktop.onSettings(settings => audioIndicator.settings(settings));
window.voiceDesktop.onVisible(visible => audioIndicator.visibility(visible));
/** @type {Partial<import('../src/desktop-contract.ts').DesktopVoice>} */
let snapshot = { state: 'starting', ready: false };
let pending = false;
let draftRevision = 0;
let composing = false;
let reportedSize = '';
let followLatest = true;
let resizing = false;
/** @type {import('../src/conversation-contract.ts').GeneratedImage | undefined} */
let selectedImage;
let selectingImage = false;
let interactionEpoch = 0;
/** @param {import('../src/conversation-contract.ts').GeneratedImage | undefined} image @param {boolean} [changeDraft] */
function selectImage(image, changeDraft = true) {
  selectedImage = image;
  if (changeDraft) draftRevision++;
  get('image-attachment').hidden = !image;
  get('attachment-preview').removeAttribute('src');
  get('attachment-preview').alt = image?.alt || 'Załączony obraz';
  get('message').placeholder = image ? 'Zapytaj o obraz lub opisz zmiany…' : 'Napisz wiadomość…';
  if (image) imagePreviewCache.get(image.id).then(url => {
    if (selectedImage !== image) return;
    if (url) get('attachment-preview').src = url;
    else { selectImage(undefined); errorText.textContent = 'Wybrany obraz jest niedostępny.'; get('error').hidden = false; }
  }).catch(() => {
    if (selectedImage === image) { selectImage(undefined); errorText.textContent = 'Nie udało się wczytać wybranego obrazu.'; get('error').hidden = false; }
  });
  updateComposer();
  reportSize();
}
/** @param {import('../src/conversation-contract.ts').GeneratedImage} image */
async function toggleImage(image) {
  if (pending || selectingImage || busy() || !snapshot.ready) return;
  if (get('composer').hidden) window.voiceDesktop.open();
  await requestImageSelection(selectedImage?.id === image.id ? undefined : image);
  if (!busy()) get('message').focus({ preventScroll: true });
}
/** @param {import('../src/conversation-contract.ts').GeneratedImage | undefined} image */
async function requestImageSelection(image) {
  const conversationId = snapshot.conversation?.id ?? snapshot.threadId;
  const epoch = interactionEpoch;
  selectingImage = true; updateComposer();
  try {
    const accepted = await window.voiceDesktop.selectImage(image?.id ?? null);
    if (conversationId !== (snapshot.conversation?.id ?? snapshot.threadId) || epoch !== interactionEpoch || busy()) return;
    if (!accepted) throw new Error('Image selection rejected');
    if (snapshot.selectedImage === undefined) selectImage(image);
    else draftRevision++;
  } catch {
    errorText.textContent = 'Nie zmieniono wyboru obrazu. Poczekaj na zakończenie odpowiedzi i spróbuj ponownie.';
    get('error').hidden = false;
  } finally { selectingImage = false; updateComposer(); }
}
get('remove-attachment').addEventListener('click', async () => { await requestImageSelection(undefined); get('message').focus({ preventScroll: true }); });
/** @param {import('../src/desktop-contract.ts').ImageImportSource} source */
async function addImage(source) {
  if (pending || selectingImage || busy() || !snapshot.ready) return;
  const conversationId = snapshot.conversation?.id ?? snapshot.threadId;
  const epoch = interactionEpoch;
  selectingImage = true; updateComposer();
  try {
    const result = await window.voiceDesktop.addImage(source);
    if (conversationId !== (snapshot.conversation?.id ?? snapshot.threadId) || epoch !== interactionEpoch || busy()) return;
    if (result.status === 'imported') {
      if (snapshot.selectedImage === undefined) selectImage(result.image);
      else draftRevision++;
    }
    else if (result.status === 'error') {
      errorText.textContent = result.message || 'Nie udało się dodać obrazu.'; get('error').hidden = false;
    }
  } catch {
    errorText.textContent = 'Nie udało się dodać obrazu. Spróbuj ponownie.'; get('error').hidden = false;
  } finally {
    selectingImage = false; updateComposer();
    if (epoch === interactionEpoch && !busy()) get('message').focus({ preventScroll: true });
  }
}
get('add-image').addEventListener('click', () => { void addImage('file'); });
get('capture-screen').addEventListener('click', () => { void addImage('screen'); });
get('message').addEventListener('paste', event => {
  if (!Array.from(event.clipboardData?.items || []).some(item => item.type.startsWith('image/'))) return;
  event.preventDefault(); void addImage('clipboard');
});
const historyRenderer = createHistoryRenderer(get('history'), { onSelect: toggleImage });
const statusText = decorateNotice(get('status'), 'info');
const errorText = decorateNotice(get('error'), 'error');
decorateNotice(get('empty'), 'info');
setMessageIcon(get('answer-block'), 'answer');
function reportComposerFocus() {
  window.voiceDesktop.composerFocus(document.hasFocus() && document.activeElement === get('message') && !get('composer').hidden && !get('message').readOnly);
}
get('message').addEventListener('focus', reportComposerFocus);
get('message').addEventListener('blur', reportComposerFocus);
window.addEventListener('focus', reportComposerFocus);
window.addEventListener('blur', () => window.voiceDesktop.composerFocus(false));
/** @type {string | undefined} */
let renderedAnswer;
let renderedImages = '';
let renderedInputImages = '';
/** @type {(() => void) | undefined} */
let disposeInputImages;
function reportSize() {
  // Layout and content change in the same renderer task, before the next paint.
  // The native viewport stays fixed; IPC only updates its interaction region.
  const style = getComputedStyle(main);
  const contentHeight = main.checkVisibility()
    ? (content?.offsetHeight || 0) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0;
  const naturalHeight = (header?.offsetHeight || 32) + Math.ceil(contentHeight + (get('composer').hidden ? 0 : get('composer').offsetHeight));
  const mode = panelMode();
  const retainHeight = mode === 'chat' && ['listening', 'transcribing', 'thinking'].includes(snapshot.state || '');
  const height = Math.min(innerHeight, Math.max(64, naturalHeight + 2, retainHeight ? panel?.offsetHeight || 0 : 0));
  panel?.style.setProperty('--panel-height', `${height}px`);
  anchorLatest();
  const key = `${mode}:${height}`;
  if (key !== reportedSize) {
    reportedSize = key;
    // The host adds the existing two-pixel breathing room to reported content.
    window.voiceDesktop.resize({ height: height - 2, mode, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches });
  }
  resizing = false;
}
const sizeObserver = new ResizeObserver(reportSize);
sizeObserver.observe(content);
sizeObserver.observe(header);
sizeObserver.observe(get('composer'));
function anchorLatest() {
  if (followLatest) main.scrollTop = main.scrollHeight;
}
// Keep the latest message anchored before painting a resized viewport.
const viewportObserver = new ResizeObserver(anchorLatest);
viewportObserver.observe(main);
viewportObserver.observe(content);
window.addEventListener('resize', reportSize);
main.addEventListener('scroll', () => {
  if (!resizing) followLatest = main.scrollHeight - main.clientHeight - main.scrollTop <= 32;
});
get('pin').addEventListener('click', () => window.voiceDesktop.command('pin'));
get('previous').addEventListener('click', async () => {
  if (get('previous').disabled) return;
  pending = true; updateComposer();
  try {
    if (!await window.voiceDesktop.command('previous')) {
      errorText.textContent = 'Nie przywrócono rozmowy. Poczekaj na gotowość usług i spróbuj ponownie.';
      get('error').hidden = false;
    }
  } catch {
    errorText.textContent = 'Nie przywrócono rozmowy. Spróbuj ponownie.'; get('error').hidden = false;
  } finally { pending = false; updateComposer(); }
});
window.voiceDesktop.onPinned(pinned => {
  get('pin').setAttribute('aria-pressed', String(pinned));
  get('pin').setAttribute('aria-label', pinned ? 'Odepnij popup' : 'Przypnij popup');
  get('pin').title = pinned ? 'Odepnij popup' : 'Przypnij popup';
});
window.voiceDesktop.onResizing(value => {
  document.documentElement.dataset.resizing = String(value);
  resizing = value;
  anchorLatest();
});
function panelMode() {
  const mode = document.body.dataset.mode;
  return mode === 'chat' || mode === 'compose' || mode === 'compact' ? mode : 'peek';
}
const busy = () => ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(snapshot.state || 'starting');
const canSubmit = () => !pending && !selectingImage && !busy() && snapshot.ready && Boolean(get('message').value.trim());
main.addEventListener('image-gallery-change', () => { updateComposer(); reportSize(); });
function updateComposer() {
  const voiceInput = ['listening', 'transcribing'].includes(snapshot.state || '');
  const inlineStatus = voiceInput && !get('composer').hidden;
  get('composer').dataset.voiceInput = String(inlineStatus);
  get('composer-status').textContent = inlineStatus ? labels[snapshot.state || 'idle'] || '' : '';
  get('composer-status').hidden = !inlineStatus;
  get('message').readOnly = voiceInput;
  if (voiceInput && document.activeElement === get('message')) get('message').blur();
  get('status').hidden = inlineStatus || (!snapshot.interrupted && Boolean(snapshot.answer) && !['thinking', 'starting'].includes(snapshot.state || '')) || !statusText.textContent;
  get('composer').setAttribute('aria-busy', String(pending || busy()));
  get('remove-attachment').disabled = pending || selectingImage || busy();
  get('add-image').disabled = get('capture-screen').disabled = pending || selectingImage || busy() || !snapshot.ready;
  get('attachment-progress').hidden = !selectingImage;
  for (const button of document.querySelectorAll('button.image-select, button.input-image-thumbnail')) {
    const select = /** @type {HTMLButtonElement} */ (button);
    select.setAttribute('aria-pressed', String(select.dataset.imageId === selectedImage?.id));
    select.disabled = pending || selectingImage || busy() || !snapshot.ready || select.dataset.unavailable === 'true';
  }
  get('previous').disabled = pending || busy() || !snapshot.ready || !snapshot.canRestorePrevious;
  get('previous').title = !snapshot.canRestorePrevious ? 'Brak poprzedniej rozmowy'
    : pending || busy() || !snapshot.ready ? 'Poczekaj na zakończenie odpowiedzi'
      : 'Wróć do poprzedniej rozmowy';
}
function resizeMessage() {
  const minimum = parseFloat(getComputedStyle(get('message')).minHeight);
  get('message').style.height = `${minimum}px`;
  get('message').style.height = `${Math.min(140, Math.max(minimum, get('message').scrollHeight))}px`;
}
panel.addEventListener('pointerenter', () => window.voiceDesktop.hover(true));
panel.addEventListener('pointerleave', () => window.voiceDesktop.hover(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.isComposing) window.voiceDesktop.command('hide');
});
window.voiceDesktop.onClearDraft(() => {
  if (selectedImage) void window.voiceDesktop.selectImage(null).catch(() => {});
  selectImage(undefined);
  draftRevision++; get('message').value = ''; resizeMessage(); updateComposer();
});
window.voiceDesktop.onMode(mode => {
  const changed = document.body.dataset.mode !== mode;
  if (changed) {
    document.documentElement.dataset.resizing = 'true';
    resizing = true;
    followLatest = true;
  }
  document.body.dataset.mode = mode;
  const editable = mode === 'chat' || mode === 'compose' || mode === 'compact';
  get('composer').hidden = !editable;
  get('history').hidden = mode !== 'chat' || !(snapshot.history?.length);
  refreshImageVisibility();
  if (!editable) get('message').blur();
  if (editable) {
    resizeMessage();
    if (!['listening', 'transcribing'].includes(snapshot.state || '')) get('message').focus({ preventScroll: true });
  }
  updateComposer();
  anchorLatest();
  reportSize();
});
const labels = {
  starting: 'Uruchamiam usługi…', idle: '', listening: 'Słucham…',
  transcribing: 'Rozpoznaję mowę…', thinking: 'Codex przygotowuje odpowiedź…',
  'preparing-speech': 'Przygotowuję głos…', speaking: 'Odczytuję odpowiedź…', error: '',
};
window.voiceDesktop.onVoice(value => {
  const changedConversation = (snapshot.conversation?.id ?? snapshot.threadId) !== (value.conversation?.id ?? value.threadId);
  if (changedConversation || snapshot.operationId !== value.operationId) interactionEpoch++;
  snapshot = value;
  if (value.selectedImage !== undefined) {
    if (selectedImage?.id !== value.selectedImage?.id || selectedImage?.alt !== value.selectedImage?.alt) selectImage(value.selectedImage || undefined, false);
  } else if (selectedImage && (changedConversation || value.selectedImageId === null || !(value.conversation?.completed ?? []).some(
    exchange => [...(exchange.images || []), ...(exchange.inputImages || [])].some(image => image.id === selectedImage?.id)))) selectImage(undefined, false);
  audioIndicator.voice(value);
  const history = value.history || [];
  historyRenderer.update(history, { conversationId: value.conversation?.id, revision: value.conversation?.revision });
  get('history').hidden = document.body.dataset.mode !== 'chat' || !history.length;
  refreshImageVisibility();
  statusText.textContent = value.interrupted ? 'Odpowiedź przerwana' : value.state === 'thinking' && value.generatingImage ? 'Generuję obraz…' : labels[value.state] || '';
  const audioIssues = [value.capabilities?.recording, value.capabilities?.playback]
    .filter(capability => capability?.state === 'error' || capability?.state === 'disabled');
  const serviceMessage = [value.message || value.capabilities?.text.message,
    ...audioIssues.map(capability => capability?.message), value.inputMessage].filter(Boolean).join(' ');
  get('error').hidden = !serviceMessage;
  errorText.textContent = serviceMessage;
  setQuestionIcon(get('question-block'), value.questionSource);
  get('retry').hidden = !((value.state === 'error' && !value.ready) || audioIssues.length || value.inputMessage);
  for (const key of /** @type {const} */ (['question', 'answer'])) {
    if (key === 'answer') {
      const answer = value.answer || '';
      if (answer !== renderedAnswer) { renderAnswer(get(key), answer); renderedAnswer = answer; }
    } else get(key).textContent = value[key] || '';
    get(`${key}-block`).hidden = !value[key];
  }
  get('empty').hidden = Boolean(value.question || value.answer || value.message || value.state !== 'idle');
  const imagesKey = JSON.stringify(value.images || []);
  if (imagesKey !== renderedImages) { renderedImages = imagesKey; renderImages(get('images'), value.images, { onSelect: toggleImage }); }
  const inputImages = value.inputImages || value.conversation?.pending?.inputImages || (!value.conversation?.pending ? value.conversation?.completed.at(-1)?.inputImages : []) || [];
  const inputKey = JSON.stringify(inputImages);
  if (inputKey !== renderedInputImages) {
    renderedInputImages = inputKey; disposeInputImages?.();
    disposeInputImages = renderInputImages(get('input-images'), inputImages, { onSelect: toggleImage });
  }
  updateComposer();
  anchorLatest();
  reportSize();
});
get('message').addEventListener('input', () => {
  draftRevision++;
  resizeMessage();
  updateComposer();
  reportSize();
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
    if (await window.voiceDesktop.text(text, selectedImage?.id)) {
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
get('retry').addEventListener('click', () => window.voiceDesktop.command('retry'));
window.voiceDesktop.ready();
