import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeCompletionBoundary, CODEX_V2_COMPLETION } from '../../src/realtime-completion.ts';

test('v2 quiet window restarts on audio, explicit completion is single, and late tail fails', () => {
  let now = 0, completions = 0;
  const timers = new Set<{ due: number; callback: () => void }>();
  const boundary = new RealtimeCompletionBoundary(() => completions++, (ms, callback) => {
    const timer = { due: now + ms, callback }; timers.add(timer);
    return () => { timers.delete(timer); };
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers]) if (timer.due <= now) { timers.delete(timer); timer.callback(); }
  };
  assert.equal(CODEX_V2_COMPLETION.version, 'v2');
  boundary.transcriptFinal(); advance(200); boundary.audio();
  advance(200); assert.equal(completions, 0);
  advance(50); assert.equal(completions, 1);
  assert.equal(boundary.phase, 'draining');
  advance(300); assert.throws(() => boundary.audio(), /after the completion boundary/);
  boundary.responseDone(); assert.equal(completions, 1);
  boundary.finish(); assert.equal(boundary.phase, 'finished');
});

test('cancel removes pending completion and explicit response.done skips the fallback window', () => {
  let pending: (() => void) | undefined, completed = 0;
  const boundary = new RealtimeCompletionBoundary(() => completed++, (_ms, callback) => {
    pending = callback; return () => { pending = undefined; };
  });
  boundary.transcriptFinal(); boundary.cancel();
  assert.equal(pending, undefined); assert.equal(completed, 0);
  assert.throws(() => boundary.finish(), /unavailable/);
  const explicit = new RealtimeCompletionBoundary(() => completed++);
  explicit.responseDone(); assert.equal(completed, 1); explicit.finish();
});
