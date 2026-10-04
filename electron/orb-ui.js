import '../preview/voice-orb.js';

const orb = document.querySelector('voice-orb');
window.orbDesktop.onPresence(presence => {
  if (presence === 'visible') {
    requestAnimationFrame(() => requestAnimationFrame(() => { document.body.dataset.presence = 'visible'; }));
  } else if (presence === 'leaving') {
    document.body.dataset.presence = 'leaving';
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) window.orbDesktop.exitComplete();
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
