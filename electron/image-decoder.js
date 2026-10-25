window.imageDecoder.onSource(async ({ token, mime, base64 }) => {
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Unsupported image');
    const image = new Image();
    image.src = `data:${mime};base64,${base64}`;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) throw new Error('Image too large');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(image, 0, 0);
    const png = canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
    window.imageDecoder.result({ token, png });
  } catch { window.imageDecoder.result({ token, error: true }); }
});
