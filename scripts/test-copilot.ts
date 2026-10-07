import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCopilotGesture } from '../src/keyboard/copilot-gesture.ts';

function setup() {
  let time = 0, id = 0;
  const tasks = new Map<ReturnType<typeof setTimeout>, { at: number; callback(): void }>();
  const actions: string[] = [];
  const gesture = createCopilotGesture({
    down: () => { actions.push('capture'); },
    hold: () => { actions.push('listening'); },
    tap: () => { actions.push('discard', 'compose'); },
    release: () => { actions.push('transcribe'); },
  }, 250, {
    setTimeout(callback, delay) {
      const key = ++id as unknown as ReturnType<typeof setTimeout>;
      tasks.set(key, { at: time + delay, callback });
      return key;
    },
    clearTimeout(key) { if (key !== undefined) tasks.delete(key); },
  }, () => time);
  return { gesture, actions, advance(ms: number, runTimers = true) {
    time += ms;
    if (runTimers) for (const [key, task] of [...tasks]) if (task.at <= time) {
      tasks.delete(key); task.callback();
    }
  } };
}

test('short press opens text input and discards audio without transcription', () => {
  const { gesture: g, actions, advance } = setup();
  g.down(); advance(249); g.up(); advance(1000);
  assert.deepEqual(actions, ['capture', 'discard', 'compose']);
});

test('holding confirms voice recording and transcribes only on release', () => {
  const { gesture: g, actions, advance } = setup();
  g.down(); advance(250);
  assert.deepEqual(actions, ['capture', 'listening']);
  advance(700); g.up();
  assert.deepEqual(actions, ['capture', 'listening', 'transcribe']);
});

test('keyboard repeats and unmatched releases cannot duplicate actions', () => {
  const { gesture: g, actions, advance } = setup();
  g.up(); g.down(); advance(100); g.down(); advance(100); g.up(); g.up();
  assert.deepEqual(actions, ['capture', 'discard', 'compose']);
  g.down(); advance(400); g.down(); g.up();
  assert.deepEqual(actions.slice(3), ['capture', 'listening', 'transcribe']);
});

test('release at the threshold counts as a hold even if its timer is overdue', () => {
  const { gesture: g, actions, advance } = setup();
  g.down(); advance(250, false); g.up(); advance(1000);
  assert.deepEqual(actions, ['capture', 'listening', 'transcribe']);
});

test('reset cancels the pending hold and allows the next tap', () => {
  const { gesture: g, actions, advance } = setup();
  g.down(); advance(100); g.cancel(); advance(300); g.up();
  assert.deepEqual(actions, ['capture']);
  g.down(); advance(80); g.up();
  assert.deepEqual(actions, ['capture', 'capture', 'discard', 'compose']);
});
