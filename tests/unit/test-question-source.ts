import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationSession } from '../../src/conversation-session.ts';
import { answerSession, emptySession, exchangeFingerprint, validExchange } from '../../src/conversation-model.ts';
import { decodeHistory, encodeHistory } from '../../src/conversation-format.ts';
import { LocalVoiceEngine } from '../../src/voice/local-engine.ts';
import { RealtimeVoiceEngine } from '../../src/voice/realtime-engine.ts';
import type { ConversationClient, QuestionSource } from '../../src/conversation-contract.ts';
const require = createRequire(import.meta.url);
const { parseWorkerEvent } = require('../../src/desktop-validation.cjs');
const { createConversationPresentation } = require('../../electron/desktop-conversation.cjs');
const id = '11111111-1111-1111-1111-111111111111';

test('source survives history serialization while legacy data and fingerprints stay compatible', () => {
  for (const questionSource of ['voice', 'text'] as const) {
    const state = answerSession({ ...emptySession(), threadId: id }, { exchangeId: 'exchange_1', prompt: 'Q', answer: 'A', questionSource }, 1);
    const exchange = state.exchanges[0];
    assert.equal(decodeHistory(JSON.parse(encodeHistory(id, 1, state.exchanges)), id).exchanges[0].questionSource, questionSource);
    assert.equal(exchangeFingerprint(exchange), exchangeFingerprint({ ...exchange, questionSource: undefined }));
  }
  assert.equal(decodeHistory([{ question: 'Q', answer: 'A' }], id).exchanges[0].questionSource, undefined);
  assert.equal(validExchange({ question: 'Q', answer: 'A', questionSource: 'unknown' }), false);
});

test('worker boundary and popup preserve pending, committed and legacy sources', () => {
  const completed = [{ id: 'e1', revision: 1, question: 'Q', answer: 'A', questionSource: 'voice' }];
  const snapshot = { type: 'voice', state: 'thinking', ready: true, health: 'ready', mode: 'local', threadId: id,
    capabilities: { text: { state: 'ready' }, recording: { state: 'ready' }, playback: { state: 'ready' } },
    canRestorePrevious: false, revision: 1, operationId: 1,
    conversation: { id, revision: 1, completed, pending: { id: 'op1', revision: 1, question: 'Q2', answer: '', questionSource: 'text' } } };
  const parsed = parseWorkerEvent(snapshot);
  assert.equal(parsed.conversation.pending.questionSource, 'text');
  const presentation = createConversationPresentation();
  assert.equal(presentation.update(parsed).questionSource, 'text');
  assert.equal(presentation.update({ conversation: { id, revision: 2, completed, pending: null } }).questionSource, 'voice');
  assert.equal(presentation.update({ conversation: { id, revision: 3, completed: [{ question: 'old', answer: 'old' }], pending: null } }).questionSource, undefined);
  snapshot.conversation.pending.questionSource = 'unknown';
  assert.equal(parseWorkerEvent(snapshot), null);
});

test('interrupted voice reply retains its source after reset and restore', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'question-source-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const session = new ConversationSession(cwd); session.threadId = id;
  session.interruptTurn({ id, exchanges: [] }, { prompt: 'Q', answer: 'partial', questionSource: 'voice' });
  session.reset(); session.restorePrevious();
  assert.equal(session.currentExchanges[0].questionSource, 'voice');
  assert.equal(session.currentExchanges[0].interrupted, true);
});

test('local transcription, typed messages and realtime image fallback forward the correct source', async () => {
  const sources: (QuestionSource | undefined)[] = [];
  const client: ConversationClient = { currentThreadId: null, currentExchanges: [], canRestorePrevious: false,
    start: async () => {}, stop() {}, cancel() {}, reset() {}, expireConversation() {}, restorePrevious: async () => false,
    respond: async (prompt, _signal, questionSource) => { sources.push(questionSource); return { prompt, answer: 'A', questionSource }; },
    generateImage: async (prompt, _signal, questionSource) => { sources.push(questionSource); return { prompt, answer: 'image', questionSource }; } };
  const engine = new LocalVoiceEngine(client, { start: async () => {}, stop() {}, transcribe: async () => 'Q' },
    { start: async () => {}, stop() {}, shutdown() {}, speak: async () => true });
  assert.equal((await engine.respondAudio('wav')).questionSource, 'voice');
  assert.equal((await engine.respond('typed')).questionSource, 'text');
  assert.equal((await engine.respond('/image square', undefined, 'voice')).questionSource, 'voice');
  const realtime = new RealtimeVoiceEngine({ ...client, respondAudio: async (_wav, _signal, callbacks) => {
    callbacks?.onTranscript?.('user', '/image square', true); throw new Error('Cancelled');
  } });
  assert.equal((await realtime.respondAudio('wav')).questionSource, 'voice');
  assert.deepEqual(sources, ['voice', 'text', 'voice', 'voice']);
});
