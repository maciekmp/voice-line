const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDesktopRequest, parseWorkerEvent } = require('../../src/desktop-validation.cjs');
const { createWorkerEventReceiver } = require('../../electron/desktop-worker.cjs');

function snapshot() {
  return { type: 'voice', state: 'idle', ready: true, health: 'ready', mode: 'local',
    capabilities: { text: { state: 'ready' }, recording: { state: 'ready' }, playback: { state: 'ready' } },
    threadId: 'conversation-1', canRestorePrevious: false, revision: 3, operationId: null,
    conversation: { id: 'conversation-1', revision: 2, pending: null,
      completed: [{ id: 'exchange-1', revision: 1, question: 'Q', answer: 'A',
        images: [{ id: 'a'.repeat(64), alt: 'obraz' }] }] } };
}

test('desktop requests reject malformed payloads and preserve exact clipboard code', () => {
  assert.deepEqual(parseDesktopRequest('voice:copy-code', '\tcode\r\n'), { channel: 'voice:copy-code', value: '\tcode\r\n' });
  assert.deepEqual(parseDesktopRequest('voice:text', '  pytanie\n'), { channel: 'voice:text', value: 'pytanie' });
  for (const [channel, value] of [
    ['voice:text', ' '], ['voice:text', 'a'.repeat(12001)], ['voice:copy-code', {}],
    ['voice:command', 'shutdown'], ['voice:command', { command: 'cancel' }], ['voice:hover', 1],
    ['voice:resize', { mode: 'chat', height: 100, reducedMotion: 'false' }],
    ['voice:resize', { mode: 'unknown', height: 100, reducedMotion: false }],
    ['voice:resize', { mode: 'chat', height: Infinity, reducedMotion: false }],
    ['voice:image-save', '../secret'], ['voice:image-preview', 'A'.repeat(64)],
    ['voice:ready', {}], ['voice:open', true], ['unknown', undefined],
  ]) assert.equal(parseDesktopRequest(channel, value), null, channel);
  assert.deepEqual(parseDesktopRequest('voice:resize', { mode: 'chat', height: 100.5, reducedMotion: true, extra: 'discard' }),
    { channel: 'voice:resize', value: { mode: 'chat', height: 100.5, reducedMotion: true } });
});

test('worker validation checks canonical history, consistency and nested image references', () => {
  const valid = snapshot();
  assert.deepEqual(parseWorkerEvent(valid), valid);
  const variants = [null, [], {}, { ...valid, state: 'unknown' }, { ...valid, health: 'error' },
    { ...valid, revision: -1 }, { ...valid, operationId: NaN }, { ...valid, canRestorePrevious: 1 },
    { ...valid, threadId: 'other' }, { ...valid, mode: 'unknown' }, { ...valid, message: {} },
    { ...valid, generatingImage: 'yes' }, { ...valid, capabilities: undefined },
    { ...valid, capabilities: { ...valid.capabilities, text: { state: 'error' } } },
    { ...valid, capabilities: { ...valid.capabilities, recording: { state: 'unknown' } } },
    { ...valid, conversation: { ...valid.conversation, revision: 1.5 } },
    { ...valid, conversation: { ...valid.conversation, pending: { id: 'op', revision: 1, question: 'Q', answer: null } } },
    { ...valid, conversation: { ...valid.conversation, completed: [...valid.conversation.completed, ...valid.conversation.completed] } },
    { ...valid, conversation: { ...valid.conversation, completed: [{ question: 'Q', answer: 'A', images: [{ id: '../secret', alt: 'bad' }] }] } },
  ];
  for (const invalid of variants) assert.equal(parseWorkerEvent(invalid), null);
});

test('worker boundary strips unknown fields and detaches nested data from the incoming object', () => {
  const input = snapshot();
  input.answer = 'forged display answer';
  input.history = [{ question: 'forged' }];
  input.conversation.completed[0].unexpected = () => {};
  const parsed = parseWorkerEvent(input);
  assert.equal(parsed.answer, undefined);
  assert.equal(parsed.history, undefined);
  assert.equal(parsed.conversation.completed[0].unexpected, undefined);
  input.conversation.completed[0].images[0].alt = 'mutated';
  assert.equal(parsed.conversation.completed[0].images[0].alt, 'obraz');
});

test('production worker receiver rejects malformed snapshots and filters audio by current phase', () => {
  const voices = [], levels = []; let compose = 0;
  const host = { voice: { state: 'listening' }, sendVoice: event => voices.push(event),
    onLevel: value => levels.push(value), compose: () => compose++ };
  const receive = createWorkerEventReceiver(host);
  assert.equal(receive({ type: 'voice', state: 'idle' }), false);
  assert.equal(voices.length, 0);
  assert.equal(receive(snapshot()), true);
  assert.equal(voices.length, 1);
  receive({ type: 'level', source: 'speaking', level: 0.5 });
  receive({ type: 'level', source: 'listening', level: 2 });
  receive({ type: 'level', source: 'listening', level: Infinity });
  assert.deepEqual(levels, [1]);
  receive({ type: 'ui', action: 'unknown' });
  receive({ type: 'ui', action: 'compose' });
  assert.equal(compose, 1);
});
