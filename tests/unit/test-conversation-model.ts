import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySession, answerSession, resetSession, restoreSession, forgetSessions, hydrateSession, sessionExpired, copyExchange } from '../../src/conversation-model.ts';

const id = '11111111-1111-1111-1111-111111111111';
test('pure transitions preserve old snapshots and restore the selected history', () => {
  const initial = { ...emptySession(), threadId: id };
  const answered = answerSession(initial, { prompt: 'Q', answer: 'A' }, 1000);
  const before = structuredClone(answered);
  Object.freeze(answered); Object.freeze(answered.exchanges);
  const reset = resetSession(answered);
  assert.deepEqual(answered, before);
  assert.equal(initial.exchanges.length, 0);
  assert.equal(reset.threadId, null);
  assert.equal(reset.previousThreadId, id);
  const restored = restoreSession(reset, 2000);
  assert.equal(restored.threadId, id);
  assert.equal(restored.lastAnswerAt, 2000);
  assert.equal(restored.revision, initial.revision + 3);
  const forgotten = forgetSessions(restored, [id]);
  assert.equal(forgotten.threadId, null);
  assert.equal(restored.threadId, id);
  assert.equal(sessionExpired(answered, 120999), false);
  assert.equal(sessionExpired(answered, 121000), true);
  assert.equal(sessionExpired(answered, 999), true);
});

test('history and replies copy nested artifact references at the model boundary', () => {
  const images = [{ id: 'a'.repeat(64), alt: 'original' }];
  const imageTask = { threadId: id, turnId: 'turn_1' };
  const answered = answerSession({ ...emptySession(), threadId: id }, { prompt: 'Q', answer: 'A', images, imageTask }, 1000);
  images[0].alt = 'mutated'; imageTask.turnId = 'mutated';
  assert.equal(answered.exchanges[0].images![0].alt, 'original');
  assert.equal(answered.exchanges[0].imageTask!.turnId, 'turn_1');
  const history = hydrateSession(emptySession(), 'other', answered.exchanges);
  assert.equal(history.threadId, null);
  const hydrated = hydrateSession({ ...emptySession(), threadId: id }, id, answered.exchanges);
  const exported = copyExchange(hydrated.exchanges[0]);
  exported.images![0].alt = 'external';
  assert.equal(hydrated.exchanges[0].images![0].alt, 'original');
  assert.equal(hydrated.revision, 1);
});
