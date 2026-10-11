const { parseWorkerEvent } = require('../src/desktop-validation.cjs');

/** @param {{sendVoice: (snapshot: import('../src/application-contract.ts').ApplicationSnapshot) => void,
 * voice: {state: string}, onLevel: (level: number) => void, compose: (action: import('../src/application-contract.ts').UiIntent) => void}} host */
function createWorkerEventReceiver(host) {
  /** @param {unknown} payload */
  return payload => {
    const event = parseWorkerEvent(payload);
    if (!event) return false;
    if (event.type === 'voice') host.sendVoice(event);
    else if (event.type === 'level' && event.source === host.voice.state) host.onLevel(event.level);
    else if (event.type === 'ui') host.compose(event.action);
    return true;
  };
}
module.exports = { createWorkerEventReceiver };
