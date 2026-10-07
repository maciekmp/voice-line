import '../preview/voice-orb.js';

const orb = document.querySelector('voice-orb');
orb.setAttribute('audio-reactive', '');
window.orbDesktop.onLevel(level => { orb.level = level; });
document.querySelector('button').addEventListener('pointerenter', () => window.orbDesktop.hover(true));
document.querySelector('button').addEventListener('pointerleave', () => window.orbDesktop.hover(false));
// Toggle on press, before activation/animation can move a surface on mouse-up.
document.querySelector('button').addEventListener('pointerdown', event => {
  if (event.button === 0) window.orbDesktop.open();
});
document.querySelector('button').addEventListener('click', event => {
  if (event.detail === 0) window.orbDesktop.open(); // Keyboard activation.
});
window.orbDesktop.onVoice(({ state, message }) => {
  const labels = { starting: 'Uruchamianie', idle: 'Gotowy', listening: 'Słucham', transcribing: 'Rozpoznaję mowę', thinking: 'Przygotowuję odpowiedź', 'preparing-speech': 'Przygotowuję głos', speaking: 'Odczytuję odpowiedź', error: 'Wymagana uwaga' };
  const button = document.querySelector('button');
  button.removeAttribute('title');
  button.setAttribute('aria-label', `${labels[state] || 'Voice Line'} — kliknij, aby rozwinąć lub zwinąć rozmowę${message ? `: ${message}` : ''}`);
  button.dataset.state = state;
});
window.orbDesktop.onPresence(presence => {
  if (presence === 'visible') {
    requestAnimationFrame(() => requestAnimationFrame(() => { document.body.dataset.presence = 'visible'; }));
  } else if (presence === 'leaving' || presence === 'hidden') {
    document.body.dataset.presence = presence;
    if (presence === 'leaving' && matchMedia('(prefers-reduced-motion: reduce)').matches) window.orbDesktop.exitComplete();
  }
});
orb.addEventListener('transitionend', event => {
  if (event.target === orb && event.propertyName === 'opacity' && document.body.dataset.presence === 'leaving') {
    window.orbDesktop.exitComplete();
  }
});
window.orbDesktop.onSettings(({ state, paused }) => {
  if (orb.state !== state) orb.level = 0;
  orb.state = state;
  orb.toggleAttribute('paused', paused);
  document.querySelector('button').toggleAttribute('data-paused', paused);
});
window.orbDesktop.ready();
