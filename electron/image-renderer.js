export function renderImages(container, images = []) {
  container.replaceChildren();
  for (const image of images) {
    if (!/^[a-f0-9]{64}$/.test(image?.id)) continue;
    const figure = document.createElement('figure');
    figure.className = 'generated-image';
    const preview = document.createElement('img');
    preview.alt = image.alt || 'Wygenerowany obraz';
    preview.decoding = 'async';
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
      preview.hidden = true;
      feedback.textContent = 'Nie udało się wczytać obrazu. Wygeneruj go ponownie.';
      save.disabled = true;
      save.hidden = true;
    });
    window.orbDesktop.imagePreview(image.id).then(url => {
      if (!figure.isConnected) return;
      if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) preview.src = url;
      else { preview.hidden = true; feedback.textContent = 'Obraz jest niedostępny. Wygeneruj go ponownie.'; save.disabled = true; save.hidden = true; }
    }).catch(() => { if (figure.isConnected) { preview.hidden = true; feedback.textContent = 'Nie udało się wczytać obrazu.'; save.disabled = true; save.hidden = true; } });
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.setAttribute('aria-busy', 'true');
      try {
        const result = await window.orbDesktop.saveImage(image.id);
        feedback.textContent = result === 'saved' ? 'Zapisano obraz.' : result === 'cancelled' ? '' : 'Nie udało się zapisać obrazu. Spróbuj ponownie.';
      } catch { feedback.textContent = 'Nie udało się zapisać obrazu. Spróbuj ponownie.'; }
      finally { save.disabled = false; save.removeAttribute('aria-busy'); }
    });
  }
}
