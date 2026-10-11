// The only owner of overlay visibility and interaction mode. Geometry and
// renderer animations are deliberately handled by the native view adapter.
const ACTIVE = new Set(['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']);

function createOverlayController({ onChange, delay = 1000, completionDelay = 2000, timers = globalThis }) {
  let voiceState = 'starting';
  let mode = 'hidden';
  let dismissed = false;
  let pinned = false;
  let composerFocused = false;
  let expiry;
  let completionExpiry;
  let completionRevision = 0;
  let revision = 0;
  const hovered = new Set();
  let last = '';

  function snapshot() {
    return { mode, pinned, orbVisible: ACTIVE.has(voiceState) || hovered.size > 0 || expiry !== undefined || completionExpiry !== undefined
      || (!dismissed && mode !== 'hidden') };
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
    if (pinned || composerFocused || ACTIVE.has(voiceState) || completionExpiry !== undefined) return;
    const expected = revision;
    expiry = timers.setTimeout(() => {
      if (expected !== revision || hovered.size || pinned || composerFocused) return;
      expiry = undefined;
      dismissed = true;
      mode = 'hidden';
      publish();
    }, delay);
  }
  function cancelCompletion() {
    completionRevision++;
    timers.clearTimeout(completionExpiry);
    completionExpiry = undefined;
  }
  function retainCompletion() {
    cancelExpiry();
    cancelCompletion();
    const expected = completionRevision;
    completionExpiry = timers.setTimeout(() => {
      if (expected !== completionRevision) return;
      completionExpiry = undefined;
      if (!hovered.size && !pinned && !composerFocused) {
        dismissed = true;
        mode = 'hidden';
      }
      publish();
    }, completionDelay);
  }
  return {
    snapshot,
    togglePin() {
      if (mode === 'hidden') return;
      pinned = !pinned;
      cancelExpiry();
      if (!pinned && !hovered.size) scheduleExpiry();
      publish();
    },
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
      if (mode === 'peek') composerFocused = false;
      publish(mode === 'chat');
    },
    compose() {
      cancelExpiry();
      dismissed = false;
      mode = 'compose';
      publish(true);
    },
    composerFocus(focused) {
      focused = focused && (mode === 'chat' || mode === 'compose');
      if (composerFocused === focused) return;
      composerFocused = focused;
      if (focused) cancelExpiry();
      else if (!hovered.size && mode !== 'hidden') scheduleExpiry();
      publish();
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
      const wasActive = ACTIVE.has(voiceState);
      const newTurn = (state === 'listening' && voiceState !== 'listening')
        || (ACTIVE.has(state) && !ACTIVE.has(voiceState));
      voiceState = state;
      if (mode === 'compose' && ACTIVE.has(state)) mode = 'chat';
      if (newTurn) {
        // A previous turn's timeout must never hide the new recording.
        cancelExpiry();
        cancelCompletion();
        dismissed = false;
        if (mode === 'hidden') mode = 'peek';
      }
      if (wasActive && !ACTIVE.has(state) && mode !== 'hidden') retainCompletion();
      publish();
    },
    dismiss() {
      pinned = false;
      composerFocused = false;
      cancelExpiry();
      cancelCompletion();
      hovered.delete('panel');
      mode = 'hidden';
      publish();
    },
    dispose() { cancelExpiry(); cancelCompletion(); hovered.clear(); },
  };
}

module.exports = { createOverlayController };
