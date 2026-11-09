let token, start;
const selection = document.getElementById('selection');
window.screenSelector.onFrame(frame => { token = frame.token; document.getElementById('screen').src = frame.image; });
const point = event => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) });
function rectangle(end) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
}
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !token) return;
  start = point(event); selection.hidden = false;
  document.body.setPointerCapture(event.pointerId);
  Object.assign(selection.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' });
});
document.addEventListener('pointermove', event => {
  if (!start) return;
  const rect = rectangle(point(event));
  Object.assign(selection.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
});
document.addEventListener('pointerup', event => {
  if (!start || event.button !== 0) return;
  const rect = rectangle(point(event)); start = undefined;
  if (rect.width >= 1 && rect.height >= 1) window.screenSelector.select({ token, rect });
  else selection.hidden = true;
});
document.addEventListener('pointercancel', () => { start = undefined; selection.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.screenSelector.select({ token, cancel: true });
});
