// The only owner of overlay visibility and interaction mode. Geometry and
// renderer animations are deliberately handled by the native view adapter.
const ACTIVE = new Set(['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']);

function createOverlayController({ onChange, delay = 1000, timers = globalThis }) {
  let voiceState = 'starting';
  let mode = 'hidden';
  let dismissed = false;
  let expiry;
  let revision = 0;
  const hovered = new Set();
  let last = '';

  function snapshot() {
    return { mode, orbVisible: hovered.size > 0 || expiry !== undefined
      || (!dismissed && (ACTIVE.has(voiceState) || mode !== 'hidden')) };
  }
  function publish(focus = false) {
    const value = snapshot();
    const key = JSON.stringify(value);
    if (key !== last || focus) { last = key; onChange(value, { focus }); }
  }
  function cancelExpiry() {
    revision++;
    timers.clearTimeout(expiry);
    expiry = undefined;
  }
  function scheduleExpiry() {
    cancelExpiry();
    const expected = revision;
    expiry = timers.setTimeout(() => {
      if (expected !== revision || hovered.size) return;
      expiry = undefined;
      dismissed = true;
      mode = 'hidden';
      publish();
    }, delay);
  }
  return {
    snapshot,
    open(chat = true) {
      cancelExpiry();
      dismissed = false;
      if (chat) mode = 'chat';
      else if (mode === 'hidden') mode = 'peek';
      publish(chat);
    },
    toggle() {
      cancelExpiry();
      dismissed = false;
      mode = mode === 'chat' || mode === 'compose' ? 'peek' : 'chat';
      publish(mode === 'chat');
    },
    compose() {
      cancelExpiry();
      dismissed = false;
      mode = 'compose';
      publish(true);
    },
    hover(surface, entered) {
      if (entered) {
        hovered.add(surface);
        cancelExpiry();
        dismissed = false;
        if (surface === 'orb' && mode === 'hidden') mode = 'peek';
      } else {
        const wasInside = hovered.delete(surface);
        if (wasInside && !hovered.size) scheduleExpiry();
      }
      publish();
    },
    voice(state) {
      const newTurn = state === 'listening' && voiceState !== 'listening';
      voiceState = state;
      if (mode === 'compose' && ACTIVE.has(state)) mode = 'chat';
      if (newTurn) {
        // A previous turn's timeout must never hide the new recording.
        cancelExpiry();
        dismissed = false;
      }
      publish();
    },
    dismiss() {
      cancelExpiry();
      hovered.delete('panel');
      mode = 'hidden';
      publish();
    },
    dispose() { cancelExpiry(); hovered.clear(); },
  };
}

module.exports = { createOverlayController };
