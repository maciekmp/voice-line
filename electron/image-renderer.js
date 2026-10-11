import { createImagePreviewCache } from './image-preview-cache.js';

export const imagePreviewCache = createImagePreviewCache({ load: id => window.voiceDesktop.imagePreview(id) });
/** @type {WeakMap<HTMLElement, () => void>} */
const cleanups = new WeakMap();
/** @type {Map<Element, (visible: boolean) => void>} */
const watched = new Map();
/** @type {IntersectionObserver | undefined} */
let observer;
let fallbackListening = false;
let fallbackFrame = 0;
function refreshFallback() {
  cancelAnimationFrame(fallbackFrame);
  fallbackFrame = requestAnimationFrame(() => {
    for (const [element, update] of watched) {
      const rect = element.getBoundingClientRect();
      update(element.getClientRects().length > 0 && rect.bottom >= -160 && rect.top <= innerHeight + 160);
    }
  });
}
export function refreshImageVisibility() {
  if (!observer && watched.size) refreshFallback();
}
/** @param {Element} element @param {(visible: boolean) => void} update */
function watch(element, update) {
  if (!observer && typeof IntersectionObserver !== 'undefined') observer = new IntersectionObserver(entries => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: '160px' });
  watched.set(element, update);
  if (observer) observer.observe(element);
  else {
    if (!fallbackListening) {
      window.addEventListener('scroll', refreshFallback, { passive: true });
      window.addEventListener('resize', refreshFallback);
      fallbackListening = true;
    }
    refreshFallback();
  }
  return () => {
    observer?.unobserve(element); watched.delete(element);
    if (!observer && watched.size === 0 && fallbackListening) {
      window.removeEventListener('scroll', refreshFallback);
      window.removeEventListener('resize', refreshFallback);
      cancelAnimationFrame(fallbackFrame);
      fallbackListening = false;
    }
  };
}

/** @param {HTMLElement} container @param {import('../src/conversation-contract.ts').GeneratedImage[]} [images]
 * @param {{lazy?: boolean}} [options] @returns {() => void} */
export function renderImages(container, images = [], { lazy = false } = {}) {
  cleanups.get(container)?.();
  /** @type {(() => void)[]} */
  const dispose = [];
  let active = true;
  const cleanup = () => { active = false; for (const cancel of dispose) cancel(); };
  cleanups.set(container, cleanup);
  container.replaceChildren();
  for (const image of images) {
    if (!/^[a-f0-9]{64}$/.test(image?.id)) continue;
    const figure = document.createElement('figure');
    figure.className = 'generated-image';
    const preview = document.createElement('img');
    preview.alt = image.alt || 'Wygenerowany obraz';
    preview.decoding = 'async';
    const critical = !lazy && container.childElementCount === 0;
    if (lazy) { preview.loading = 'lazy'; preview.fetchPriority = 'low'; }
    else if (critical) preview.fetchPriority = 'high';
    const frame = document.createElement('div');
    frame.className = 'image-preview';
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'popup-action image-save'; save.title = 'Zapisz obraz';
    save.setAttribute('aria-label', `Zapisz obraz: ${preview.alt.slice(0, 160)}`);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
    for (const d of ['M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d); icon.append(path);
    }
    save.append(icon);
    const feedback = document.createElement('p');
    feedback.className = 'image-feedback'; feedback.setAttribute('role', 'status');
    frame.append(preview, save);
    figure.append(frame, feedback);
    container.append(figure);
    preview.addEventListener('error', () => {
      imagePreviewCache.invalidate(image.id);
      preview.hidden = true;
      feedback.textContent = 'Nie udało się wczytać obrazu. Wygeneruj go ponownie.';
      save.disabled = true;
      save.hidden = true;
    });
    let visible = !lazy;
    let loading = false;
    const load = () => {
      if (!active || !visible || loading || preview.hasAttribute('src')) return;
      loading = true;
      imagePreviewCache.get(image.id).then(url => {
        if (!active || !figure.isConnected || !visible) return;
        if (url) { preview.removeAttribute('fetchpriority'); if (critical) preview.fetchPriority = 'high'; preview.src = url; }
        else { preview.hidden = true; feedback.textContent = 'Obraz jest niedostępny. Wygeneruj go ponownie.'; save.disabled = true; save.hidden = true; }
      }).catch(() => {
        if (active && figure.isConnected && visible) { preview.hidden = true; feedback.textContent = 'Nie udało się wczytać obrazu.'; save.disabled = true; save.hidden = true; }
      }).finally(() => { loading = false; });
    };
    preview.addEventListener('load', () => {
      if (preview.naturalWidth && preview.naturalHeight) preview.style.aspectRatio = `${preview.naturalWidth} / ${preview.naturalHeight}`;
    });
    if (lazy) dispose.push(watch(figure, intersects => {
      visible = intersects && figure.getClientRects().length > 0;
      if (visible) load();
      else preview.removeAttribute('src'); // Do not retain unbounded base64 strings in offscreen DOM.
    }));
    else load();
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.setAttribute('aria-busy', 'true');
      try {
        const result = await window.voiceDesktop.saveImage(image.id);
        feedback.textContent = result === 'saved' ? 'Zapisano obraz.' : result === 'cancelled' ? '' : 'Nie udało się zapisać obrazu. Spróbuj ponownie.';
      } catch { feedback.textContent = 'Nie udało się zapisać obrazu. Spróbuj ponownie.'; }
      finally { save.disabled = false; save.removeAttribute('aria-busy'); }
    });
  }
  return cleanup;
}
