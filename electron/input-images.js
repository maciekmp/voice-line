import { imagePreviewCache } from './image-renderer.js';

/** @type {Map<Element, (visible: boolean) => void>} */
const watched = new Map();
/** @type {IntersectionObserver | undefined} */
let observer;
/** @type {WeakMap<HTMLElement, () => void>} */
const cleanups = new WeakMap();

/** Render user attachments separately from generated image galleries.
 * @param {HTMLElement} container
 * @param {import('../src/conversation-contract.ts').GeneratedImage[]} [images]
 * @param {{lazy?: boolean, onSelect?: (image: import('../src/conversation-contract.ts').GeneratedImage) => void}} [options]
 * @returns {() => void}
 */
export function renderInputImages(container, images = [], { lazy = false, onSelect } = {}) {
  cleanups.get(container)?.();
  container.replaceChildren();
  container.classList.add('input-attachments');
  container.hidden = !images.length;
  let active = true;
  /** @type {(() => void)[]} */
  const disposers = [];
  for (const image of images) {
    if (!/^[a-f0-9]{64}$/.test(image?.id)) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'input-image-thumbnail';
    button.dataset.imageId = image.id;
    const label = image.alt || 'Załączony obraz';
    button.setAttribute('aria-label', `Załącz ponownie obraz: ${label.slice(0, 160)}`);
    button.title = `Załącz ponownie: ${label.slice(0, 160)}`;
    button.disabled = !onSelect;
    const preview = document.createElement('img');
    preview.alt = label; preview.width = 48; preview.height = 48;
    preview.decoding = 'async';
    if (lazy) { preview.loading = 'lazy'; preview.fetchPriority = 'low'; }
    button.append(preview); container.append(button);
    button.addEventListener('click', () => onSelect?.(image));
    let visible = !lazy;
    let loading = false;
    const unavailable = () => {
      if (!active) return;
      preview.removeAttribute('src');
      button.disabled = true; button.dataset.unavailable = 'true';
      button.title = 'Obraz jest niedostępny. Załącz go ponownie z pliku lub schowka.';
    };
    const load = () => {
      if (!active || !visible || loading || preview.hasAttribute('src')) return;
      loading = true;
      imagePreviewCache.get(image.id).then(url => {
        if (!active || !visible || !button.isConnected) return;
        if (url) preview.src = url;
        else unavailable();
      }).catch(unavailable).finally(() => { loading = false; });
    };
    preview.addEventListener('error', () => { imagePreviewCache.invalidate(image.id); unavailable(); });
    if (lazy && typeof IntersectionObserver !== 'undefined') {
      if (!observer) observer = new IntersectionObserver(entries => {
        for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
      }, { rootMargin: '160px' });
      watched.set(button, intersects => {
        visible = intersects && button.getClientRects().length > 0;
        if (visible) load();
        else preview.removeAttribute('src');
      });
      observer.observe(button);
      disposers.push(() => { observer?.unobserve(button); watched.delete(button); });
    } else { visible = true; load(); }
  }
  const cleanup = () => { active = false; disposers.forEach(dispose => dispose()); };
  cleanups.set(container, cleanup);
  return cleanup;
}
