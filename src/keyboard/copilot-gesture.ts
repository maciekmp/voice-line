type Actions = { down(): void; hold(): void; tap(): void; release(): void };
type Timers = { setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout> | undefined): void };

export function createCopilotGesture(actions: Actions, threshold = 250,
  timers: Timers = globalThis, now: () => number = () => performance.now()) {
  let pressedAt: number | undefined;
  let confirmed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function confirm() {
    if (pressedAt === undefined || confirmed) return;
    confirmed = true;
    actions.hold();
  }
  return {
    down() {
      if (pressedAt !== undefined) return; // Ignore keyboard repeat.
      pressedAt = now();
      confirmed = false;
      actions.down();
      timer = timers.setTimeout(confirm, threshold);
    },
    up() {
      if (pressedAt === undefined) return;
      timers.clearTimeout(timer);
      // Account for an overdue timer when the event loop was busy.
      if (now() - pressedAt >= threshold) confirm();
      pressedAt = undefined;
      if (confirmed) actions.release();
      else actions.tap();
    },
    cancel() {
      timers.clearTimeout(timer);
      pressedAt = undefined;
      confirmed = false;
    },
  };
}
