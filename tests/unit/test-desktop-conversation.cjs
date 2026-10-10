const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversationPresentation } = require('../../electron/desktop-conversation.cjs');

const first = { id: 'exchange-1', revision: 1, question: 'Q', answer: 'A' };
const second = { id: 'exchange-2', revision: 2, question: 'Q', answer: 'A' };
const view = (completed, pending = null, id = 'conversation-1', revision = 1) => ({ id, revision, completed, pending });

test('presentation shows completed exchanges and explicit pending without inferring commits', () => {
  const model = createConversationPresentation();
  let snapshot = model.update({ state: 'idle', conversation: view([first]) });
  assert.equal(snapshot.answer, 'A');
  assert.deepEqual(snapshot.history, []);
  snapshot = model.update({ state: 'speaking', conversation: view([first], {
    id: 'operation-2', revision: 1, question: 'Q', answer: 'partial',
  }) });
  assert.deepEqual(snapshot.history, [first]);
  assert.equal(snapshot.answer, 'partial');
  assert.deepEqual(model.completed, [first]);
  snapshot = model.update({ state: 'idle', conversation: view([first], null) });
  assert.equal(snapshot.answer, 'A');
  assert.deepEqual(snapshot.history, []);
  snapshot = model.update({ state: 'idle', conversation: view([first, second], null, 'conversation-1', 2) });
  assert.deepEqual(snapshot.history, [first], 'Identical text with different exchange IDs remains two commits');
  assert.deepEqual(model.completed, [first, second]);
});

test('restore after reset requires authoritative history and local health cannot archive or commit text', () => {
  const model = createConversationPresentation();
  model.update({ conversation: view([first]) });
  model.update({ state: 'thinking', question: 'optimistic', answer: '' });
  assert.deepEqual(model.completed, [first]);
  model.update({ state: 'error', ready: false, message: 'worker unavailable' });
  assert.deepEqual(model.completed, [first]);
  let snapshot = model.update({ conversation: view([], null, null, 2) });
  assert.equal(snapshot.answer, '');
  assert.deepEqual(snapshot.history, []);
  snapshot = model.update({ conversation: view([second], null, 'conversation-2', 3) });
  assert.equal(snapshot.question, 'Q');
  assert.deepEqual(model.completed, [second]);
  snapshot = model.update({ conversation: view([first], null, 'conversation-1', 4) });
  assert.deepEqual(model.completed, [first]);
  assert.equal(snapshot.threadId, 'conversation-1');
});
