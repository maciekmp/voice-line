// One owner for panel visibility, popup mode and completion retention.
const ACTIVE = new Set(['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking']);
const EDITABLE = new Set(['compose', 'compact', 'chat']);
function createOverlayController({ onChange, completionDelay = 5000, timers = globalThis }) {
  let voiceState = 'starting', mode = 'hidden', pinned = false, composerFocused = false;
  let completionExpiry, revision = 0, last = '', holds = 0, hidingHolds = 0;
  const hovered = new Set();
  function snapshot() { return { mode, pinned }; }
  function publish(focus = false) {
    const value = snapshot(), key = JSON.stringify([value, hidingHolds > 0]);
    if (key !== last || focus) { last = key; onChange(value, { focus, suspended: hidingHolds > 0 }); }
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
      if (!holds && !hovered.size && !pinned && !composerFocused) dismiss();
    }, completionDelay);
  }
  function compose(interrupted = false) {
    if (mode === 'hidden') mode = 'compose';
    else if (interrupted) mode = mode === 'chat' ? 'chat' : 'compact';
    else mode = mode === 'chat' ? 'compact' : mode === 'peek' ? 'compact' : 'chat';
    publish(true);
  }
  return {
    hold({ hide = true } = {}) {
      holds++; cancelCompletion();
      if (hide) { hidingHolds++; hovered.clear(); composerFocused = false; }
      publish();
      let released = false;
      return (focus = true) => {
        if (released) return;
        released = true; holds--;
        if (hide) hidingHolds--;
        publish(!holds && focus);
      };
    },
    snapshot, compose, toggle: () => compose(),
    intent(action) {
      if (action === 'voice-input') {
        cancelCompletion();
        if (!EDITABLE.has(mode)) mode = 'peek';
        composerFocused = false; publish();
      } else if (action === 'text-input') {
        cancelCompletion();
        if (mode !== 'chat') mode = 'compact';
        publish();
      } else compose(action === 'correct' || action === 'continue');
    },
    open(chat = true) { mode = chat ? 'chat' : mode === 'hidden' ? 'peek' : mode; publish(chat); },
    togglePin() { if (mode !== 'hidden') { pinned = !pinned; publish(); } },
    composerFocus(focused) { composerFocused = focused && EDITABLE.has(mode); },
    hover(surface, entered) {
      if (mode === 'hidden' || surface !== 'panel') return;
      if (entered) hovered.add(surface); else hovered.delete(surface);
    },
    voice(state) {
      const wasActive = ACTIVE.has(voiceState);
      if (!wasActive && ACTIVE.has(state)) {
        cancelCompletion();
        if (mode === 'hidden') mode = 'peek';
      }
      voiceState = state;
      if (mode === 'compose' && state === 'thinking') mode = 'compact';
      if (state === 'error') cancelCompletion();
      else if (wasActive && !ACTIVE.has(state)) retainCompletion();
      publish();
    },
    dismiss, dispose() { cancelCompletion(); hovered.clear(); },
  };
}
module.exports = { createOverlayController };
