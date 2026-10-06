import '../preview/voice-orb.js';

const get = id => document.getElementById(id);
let snapshot = { state: 'starting', ready: false };
const labels = {
  starting: ['Uruchamiam usługi…', 'Przygotowuję mikrofon, rozpoznawanie mowy i głos.'],
  idle: ['Gotowy do rozmowy', 'Nagraj kolejne pytanie. Pamiętam kontekst rozmowy.'],
  listening: ['Słucham…', 'Zwolnij Copilot lub kliknij „Zakończ nagranie”.'],
  transcribing: ['Rozpoznaję mowę…', 'Możesz przerwać i nagrać pytanie ponownie.'],
  thinking: ['Przygotowuję odpowiedź…', 'Możesz przerwać i zadać inne pytanie.'],
  'preparing-speech': ['Przygotowuję głos…', 'Odpowiedź możesz już przeczytać poniżej.'],
  speaking: ['Odczytuję odpowiedź…', 'Przerwij lub zacznij nowe nagranie, aby zadać kolejne pytanie.'],
  error: ['Potrzebuję Twojej uwagi', 'Szczegóły i sposób rozwiązania znajdziesz poniżej.'],
};
window.orbDesktop.onVoice(value => {
  snapshot = value;
  const [label, hint] = labels[value.state] || labels.error;
  get('status').textContent = label;
  get('hint').textContent = hint;
  document.title = `Voice Line — ${label}`;
  document.querySelector('voice-orb').state = value.state === 'listening' ? 'listening' : value.state === 'speaking' ? 'speaking' : 'idle';
  get('error').hidden = !value.message;
  get('error').textContent = value.message || '';
  for (const key of ['question', 'answer']) {
    get(key).textContent = value[key] || '';
    get(`${key}-block`).hidden = !value[key];
  }
  get('empty').hidden = Boolean(value.question || value.answer);
  get('record').disabled = !value.ready && value.state !== 'error';
  get('record').textContent = !value.ready && value.state === 'error' ? 'Uruchom usługi ponownie' : value.state === 'listening' ? 'Zakończ nagranie' : 'Nagraj pytanie';
  get('record').setAttribute('aria-pressed', String(value.state === 'listening'));
  get('cancel').disabled = !value.ready || ['idle', 'error'].includes(value.state);
  get('reset').disabled = !value.ready;
});
get('record').addEventListener('click', () => {
  // Prevent repeated clicks until the engine acknowledges the transition.
  get('record').disabled = true;
  window.orbDesktop.command(!snapshot.ready ? 'retry' : snapshot.state === 'listening' ? 'release' : 'record');
});
get('cancel').addEventListener('click', () => window.orbDesktop.command('cancel'));
get('reset').addEventListener('click', () => window.orbDesktop.command('reset'));
get('hide').addEventListener('click', () => window.orbDesktop.command('hide'));
window.orbDesktop.ready();
