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
 * @param {{lazy?: boolean, onSelect?: (image: import('../src/conversation-contract.ts').GeneratedImage) => void}} [options] @returns {() => void} */
function renderImageList(container, images = [], { lazy = false, onSelect } = {}) {
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
    const select = document.createElement('button');
    select.type = 'button'; select.className = 'popup-action image-select';
    select.dataset.imageId = image.id;
    select.setAttribute('aria-label', `Załącz obraz: ${preview.alt.slice(0, 160)}`);
    select.setAttribute('aria-pressed', 'false');
    select.title = 'Załącz obraz do pytania lub edycji';
    const editIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    editIcon.setAttribute('viewBox', '0 0 24 24'); editIcon.setAttribute('aria-hidden', 'true'); editIcon.setAttribute('focusable', 'false');
    const editPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    editPath.setAttribute('fill', 'none'); editPath.setAttribute('stroke', 'currentColor'); editPath.setAttribute('stroke-width', '2');
    editPath.setAttribute('stroke-linecap', 'round'); editPath.setAttribute('stroke-linejoin', 'round');
    editPath.setAttribute('d', 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4');
    editIcon.append(editPath); select.append(editIcon);
    select.addEventListener('click', () => onSelect?.(image));
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
    frame.append(preview, ...(onSelect ? [select] : []), save);
    figure.append(frame, feedback);
    container.append(figure);
    preview.addEventListener('error', () => {
      imagePreviewCache.invalidate(image.id);
      preview.hidden = true;
      feedback.textContent = 'Nie udało się wczytać obrazu. Wygeneruj go ponownie.';
      save.disabled = true;
      save.hidden = true;
      select.disabled = true; select.dataset.unavailable = 'true';
    });
    let visible = !lazy;
    let loading = false;
    const load = () => {
      if (!active || !visible || loading || preview.hasAttribute('src')) return;
      loading = true;
      imagePreviewCache.get(image.id).then(url => {
        if (!active || !figure.isConnected || !visible) return;
        if (url) { preview.removeAttribute('fetchpriority'); if (critical) preview.fetchPriority = 'high'; preview.src = url; }
        else { preview.hidden = true; feedback.textContent = 'Obraz jest niedostępny. Wygeneruj go ponownie.'; save.disabled = true; save.hidden = true; select.disabled = true; select.dataset.unavailable = 'true'; }
      }).catch(() => {
        if (active && figure.isConnected && visible) { preview.hidden = true; feedback.textContent = 'Nie udało się wczytać obrazu.'; save.disabled = true; save.hidden = true; select.disabled = true; select.dataset.unavailable = 'true'; }
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

/** @typedef {import('../src/conversation-contract.ts').GeneratedImage} GalleryImage */
/** @typedef {{lazy?: boolean, onSelect?: (image: GalleryImage) => void}} GalleryOptions */
/** @type {WeakMap<HTMLElement, {images: GalleryImage[], lazy: boolean, onSelect?: GalleryOptions['onSelect'], active: boolean, append: (images: GalleryImage[]) => void, cleanup: () => void}>} */
const galleries = new WeakMap();

/** @param {HTMLElement} container @param {GalleryImage[]} [images] @param {GalleryOptions} [options] */
export function renderImages(container, images = [], { lazy = false, onSelect } = {}) {
  const unique = images.filter((image, index) => /^[a-f0-9]{64}$/.test(image?.id)
    && images.findIndex(other => other.id === image.id) === index);
  const previous = galleries.get(container);
  if (previous?.active && previous.lazy === lazy && previous.onSelect === onSelect
    && previous.images.length <= unique.length
    && previous.images.every((image, index) => image.id === unique[index].id && image.alt === unique[index].alt)) {
    previous.append(unique.slice(previous.images.length));
    return previous.cleanup;
  }
  previous?.cleanup();
  container.replaceChildren();
  if (!unique.length) { galleries.delete(container); return () => {}; }
  const thumbnails = document.createElement('div');
  thumbnails.className = 'image-thumbnails'; thumbnails.hidden = true;
  thumbnails.setAttribute('role', 'group'); thumbnails.setAttribute('aria-label', 'Warianty obrazu');
  const stage = document.createElement('div'); stage.className = 'image-stage';
  container.append(stage, thumbnails);
  /** @type {{button: HTMLButtonElement, preview: HTMLImageElement, image: GalleryImage}[]} */
  const entries = [];
  /** @type {string | undefined} */
  let selected;
  let visible = !lazy;
  let disposeImage = () => {};
  const state = { images: /** @type {GalleryImage[]} */ ([]), lazy, onSelect, active: true, append, cleanup };
  /** @param {GalleryImage} image */
  function show(image) {
    if (selected === image.id) return;
    selected = image.id;
    for (const entry of entries) entry.button.setAttribute('aria-pressed', String(entry.image.id === selected));
    disposeImage();
    disposeImage = renderImageList(stage, [image], { lazy, onSelect });
    container.dispatchEvent(new Event('image-gallery-change', { bubbles: true }));
  }
  function loadThumbnails() {
    if (!state.active || !visible || thumbnails.hidden) return;
    for (const entry of entries) {
      if (entry.preview.hasAttribute('src')) continue;
      imagePreviewCache.get(entry.image.id).then(url => {
        if (state.active && visible && entry.preview.isConnected && url) entry.preview.src = url;
      }).catch(() => {});
    }
  }
  /** @param {GalleryImage[]} additions */
  function append(additions) {
    for (const image of additions) {
      const index = entries.length;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'image-thumbnail';
      button.dataset.imageId = image.id;
      button.setAttribute('aria-label', `Pokaż wariant ${index + 1}: ${image.alt.slice(0, 160)}`);
      button.setAttribute('aria-pressed', 'false');
      const preview = document.createElement('img'); preview.alt = ''; preview.decoding = 'async';
      preview.width = 32; preview.height = 32; preview.fetchPriority = 'low';
      button.append(preview); thumbnails.append(button);
      entries.push({ button, preview, image }); state.images.push(image);
      button.addEventListener('click', () => show(image));
      button.addEventListener('keydown', event => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % entries.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + entries.length) % entries.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = entries.length - 1;
        else return;
        event.preventDefault(); entries[next].button.focus({ preventScroll: true }); show(entries[next].image);
      });
    }
    thumbnails.hidden = entries.length < 2;
    if (!thumbnails.hidden && thumbnails.nextElementSibling !== stage) container.insertBefore(thumbnails, stage);
    if (!selected && state.images[0]) show(state.images[0]);
    loadThumbnails();
  }
  const unwatch = lazy ? watch(thumbnails, intersects => {
    visible = intersects && thumbnails.getClientRects().length > 0;
    if (visible) loadThumbnails();
    else for (const entry of entries) entry.preview.removeAttribute('src');
  }) : () => {};
  function cleanup() { state.active = false; unwatch(); disposeImage(); }
  galleries.set(container, state);
  append(unique);
  return cleanup;
}
