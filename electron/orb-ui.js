import '../preview/voice-orb.js';

const orb = document.querySelector('voice-orb');
document.querySelector('button').addEventListener('click', () => window.orbDesktop.open());
window.orbDesktop.onVoice(({ state, message }) => {
  const labels = { starting: 'Uruchamianie', idle: 'Gotowy', listening: 'Słucham', transcribing: 'Rozpoznaję mowę', thinking: 'Przygotowuję odpowiedź', 'preparing-speech': 'Przygotowuję głos', speaking: 'Odczytuję odpowiedź', error: 'Wymagana uwaga' };
  const button = document.querySelector('button');
  button.title = `${labels[state] || 'Voice Line'} — kliknij, aby otworzyć rozmowę${message ? `: ${message}` : ''}`;
  button.setAttribute('aria-label', button.title);
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
  orb.state = state;
  orb.toggleAttribute('paused', paused);
});
window.orbDesktop.ready();
