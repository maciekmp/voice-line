// One owner for paired visibility, popup mode and completion retention.
const ACTIVE = new Set(['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']);
const EDITABLE = new Set(['compose', 'compact', 'chat']);
function createOverlayController({ onChange, completionDelay = 5000, timers = globalThis }) {
  let voiceState = 'starting', mode = 'hidden', pinned = false, composerFocused = false;
  let completionExpiry, revision = 0, last = '';
  const hovered = new Set();
  function snapshot() { return { mode, pinned, orbVisible: mode !== 'hidden' }; }
  function publish(focus = false) {
    const value = snapshot(), key = JSON.stringify(value);
    if (key !== last || focus) { last = key; onChange(value, { focus }); }
  }
  function cancelCompletion() { revision++; timers.clearTimeout(completionExpiry); completionExpiry = undefined; }
  function dismiss() {
    cancelCompletion(); mode = 'hidden'; pinned = false; composerFocused = false; hovered.clear(); publish();
  }
  function retainCompletion() {
    cancelCompletion();
    if (mode === 'hidden') return;
    const expected = revision;
    completionExpiry = timers.setTimeout(() => {
      if (revision !== expected) return;
      completionExpiry = undefined;
      if (!hovered.size && !pinned && !composerFocused) dismiss();
    }, completionDelay);
  }
  function compose(interrupted = false) {
    if (mode === 'hidden') mode = 'compose';
    else if (interrupted) mode = mode === 'chat' ? 'chat' : 'compact';
    else mode = mode === 'chat' ? 'compact' : mode === 'peek' ? 'compact' : 'chat';
    publish(true);
  }
  return {
    snapshot, compose, toggle: () => compose(),
    intent(action) {
      if (action === 'voice-input') {
        cancelCompletion(); mode = 'peek'; composerFocused = false; publish();
      } else if (action === 'text-input') {
        cancelCompletion(); mode = 'compact'; publish();
      } else compose(action === 'correct' || action === 'continue');
    },
    open(chat = true) { mode = chat ? 'chat' : mode === 'hidden' ? 'peek' : mode; publish(chat); },
    togglePin() { if (mode !== 'hidden') { pinned = !pinned; publish(); } },
    composerFocus(focused) { composerFocused = focused && EDITABLE.has(mode); },
    hover(surface, entered) {
      if (mode === 'hidden') return;
      if (entered) hovered.add(surface); else hovered.delete(surface);
    },
    voice(state) {
      const wasActive = ACTIVE.has(voiceState);
      if (!wasActive && ACTIVE.has(state)) {
        cancelCompletion();
        if (mode === 'hidden') mode = 'peek';
      }
      voiceState = state;
      if (state === 'error') cancelCompletion();
      else if (wasActive && !ACTIVE.has(state)) retainCompletion();
      publish();
    },
    dismiss, dispose() { cancelCompletion(); hovered.clear(); },
  };
}
module.exports = { createOverlayController };
