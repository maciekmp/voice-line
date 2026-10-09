import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationSession } from '../src/conversation-session.ts';
import { CodexClient } from '../src/codex.ts';
import { CodexAppServer } from '../src/codex-app-server.ts';
import { readConversationHistory } from '../src/conversation-history.ts';

const firstId = '11111111-1111-1111-1111-111111111111';
const secondId = '22222222-2222-2222-2222-222222222222';
const reply = { prompt: 'Pytanie', answer: 'Odpowiedź' };

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'voice-line-session-'));
  const file = join(cwd, '.chatgpt-button-session.json');
  t.after(() => { if (existsSync(file)) unlinkSync(file); rmdirSync(cwd); });
  return { cwd, file };
}

const historyTurn = (id = 'turn', answer = reply.answer, status = 'completed') => ({ id, status,
  items: [{ type: 'agentMessage', text: JSON.stringify({ prompt: reply.prompt, answer }) }] });

for (const mode of ['cli', 'app-server'] as const) {
  test(`${mode} loads Codex messages, expires context, restores atomically and writes metadata only`, async t => {
    const { cwd, file } = fixture(t);
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    writeFileSync(file, JSON.stringify({ threadId: firstId, lastAnswerAt: now }));
    const session = new ConversationSession(cwd);
    const server = new CodexAppServer(cwd, session, mode === 'cli');
    const client = mode === 'cli' ? new CodexClient(cwd) : server;
    const calls: { method: string; threadId?: string }[] = [];
    let fail = false, failRead = false, failResume = false, emptyHistory = false;
    Object.assign(server, {
      start: async () => {},
      request: async (method: string, params: { threadId?: string; includeTurns?: boolean }) => {
        calls.push({ method, threadId: params.threadId });
        if (method === 'thread/read') {
          if (failRead) throw new Error('History failed');
          return { thread: { id: params.threadId, historyMode: 'legacy',
            turns: params.includeTurns && !emptyHistory ? [historyTurn()] : [] } };
        }
        if (method === 'thread/start') return { thread: { id: secondId } };
        if (method === 'thread/resume') {
          if (failResume) throw new Error('Resume failed');
          return { thread: { id: params.threadId } };
        }
        if (method === 'turn/start') {
          if (fail) throw new Error('Failed');
          const turn = (server as unknown as { turn: { text: string; resolve: () => void } }).turn;
          turn.text = JSON.stringify(reply);
          turn.resolve();
          Object.assign(server, { turn: null });
          return { turn: { id: 'turn-id' } };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
    });
    if (mode === 'cli') Object.assign(client, { session, historyServer: server, start: async () => {},
      run: async (args: string[]) => {
        calls.push({ method: args.includes('resume') ? 'resume' : 'new' });
        if (fail) throw new Error('Failed');
        return { text: JSON.stringify(reply), threadId: args.includes('resume') ? args.at(-2) : secondId };
      },
    });
    await (server as unknown as { hydrateSavedHistory: () => Promise<void> }).hydrateSavedHistory();
    assert.deepEqual(client.currentExchanges, [{ question: reply.prompt, answer: reply.answer }]);
    calls.length = 0;
    now += 119_999;
    await client.respond('Pierwsze pytanie');
    assert.equal(client.currentThreadId, firstId);
    assert.equal(calls[0]?.method, mode === 'cli' ? 'resume' : 'turn/start');
    const lastAnswerAt = now;
    now += 119_999;
    fail = true;
    await assert.rejects(client.respond('Nieudane pytanie'), /Failed/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastAnswerAt, lastAnswerAt);
    now++;
    fail = false;
    calls.length = 0;
    await client.respond('Nowa rozmowa');
    assert.equal(calls[0]?.method, mode === 'cli' ? 'new' : 'thread/start');
    assert.equal(client.currentThreadId, secondId);
    assert.equal(client.canRestorePrevious, true);
    const beforeFailure = readFileSync(file, 'utf8');
    failRead = true;
    await assert.rejects(client.restorePrevious(), /History failed/);
    assert.equal(client.currentThreadId, secondId);
    assert.equal(readFileSync(file, 'utf8'), beforeFailure);
    failRead = false;
    if (mode === 'app-server') {
      failResume = true;
      await assert.rejects(client.restorePrevious(), /Resume failed/);
      assert.equal(client.currentThreadId, secondId);
      assert.equal(readFileSync(file, 'utf8'), beforeFailure);
      failResume = false;
    }
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(await client.restorePrevious(cancelled.signal), false);
    assert.equal(client.currentThreadId, secondId);
    assert.equal(await client.restorePrevious(), true);
    assert.equal(client.currentThreadId, firstId);
    assert.deepEqual(client.currentExchanges, [{ question: reply.prompt, answer: reply.answer }]);
    calls.length = 0;
    await client.respond('Kontynuuj poprzednią rozmowę');
    assert.equal(calls[0]?.method, mode === 'cli' ? 'resume' : 'turn/start');
    assert.equal(client.currentThreadId, firstId);
    assert.equal(await client.restorePrevious(), true);
    assert.equal(client.currentThreadId, secondId);
    client.reset();
    assert.equal(existsSync(file), false);
    assert.equal(await client.restorePrevious(), true);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['lastAnswerAt', 'threadId']);
    client.reset();
    emptyHistory = true;
    assert.equal(await client.restorePrevious(), false);
    assert.equal(client.canRestorePrevious, false);
    assert.equal(client.currentThreadId, null);
  });
}

test('history reader handles legacy answers and skips incomplete, commentary and non-answer items', async () => {
  const turns = [historyTurn(), historyTurn('failed', 'Failed', 'failed'), historyTurn('interrupted', 'Interrupted', 'interrupted'),
    { id: 'commentary', status: 'completed', items: [
      { type: 'agentMessage', phase: 'commentary', text: JSON.stringify(reply) },
      { type: 'agentMessage', text: 'not JSON' }, { type: 'reasoning', text: JSON.stringify(reply) }] }];
  const exchanges = await readConversationHistory(async (_method, params: any) => ({
    thread: { id: firstId, historyMode: 'legacy', turns: params.includeTurns ? turns : [] },
  }), firstId);
  assert.deepEqual(exchanges, [{ question: reply.prompt, answer: reply.answer }]);
});

test('paginated history reads all turn and item pages in chronological order', async () => {
  const calls: string[] = [];
  const exchanges = await readConversationHistory(async (method, params: any) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: firstId, historyMode: 'paginated' } };
    const page = params.cursor ? 2 : 1;
    if (method === 'thread/turns/list') return { data: [{ id: `turn-${page}`, status: 'completed' }], nextCursor: page === 1 ? 'turns-2' : null };
    return { data: [{ turnId: `turn-${page}`, item: historyTurn('unused', `Answer ${page}`).items[0] }], nextCursor: page === 1 ? 'items-2' : null };
  }, firstId);
  assert.deepEqual(exchanges.map(exchange => exchange.answer), ['Answer 1', 'Answer 2']);
  assert.deepEqual(calls, ['thread/read', 'thread/turns/list', 'thread/turns/list', 'thread/items/list', 'thread/items/list']);
});

test('malformed or mismatched history fails instead of restoring an empty or different thread', async () => {
  await assert.rejects(readConversationHistory(async () => ({ thread: { id: secondId } }), firstId), /different conversation/);
  await assert.rejects(readConversationHistory(async (method) => method === 'thread/read'
    ? { thread: { id: firstId, historyMode: 'paginated' } } : { data: [], nextCursor: 'same' }, firstId), /invalid history cursor/);
});

test('context expires exactly 120 seconds after the answer', t => {
  const { cwd, file } = fixture(t);
  let now = 1_000_000;
  const session = new ConversationSession(cwd, () => now);
  session.threadId = firstId;
  session.answered(reply);
  now += 119_999;
  session.expire();
  assert.equal(session.threadId, firstId);
  now++;
  session.expire();
  assert.equal(session.threadId, null);
  assert.equal(existsSync(file), false);
});

test('each successful answer renews the window and a restart preserves its deadline', t => {
  const { cwd } = fixture(t);
  let now = 1_000_000;
  const session = new ConversationSession(cwd, () => now);
  session.threadId = firstId;
  session.answered(reply);
  now += 100_000;
  session.answered(reply);
  now += 119_999;
  assert.equal(new ConversationSession(cwd, () => now).threadId, firstId);
  now++;
  assert.equal(new ConversationSession(cwd, () => now).threadId, null);
});

test('corrupt, timestamp-free and future-dated session files do not restore context', t => {
  const { cwd, file } = fixture(t);
  for (const saved of [JSON.stringify({ threadId: firstId }), '{bad json',
    JSON.stringify({ threadId: firstId, lastAnswerAt: 2_000_000, exchanges: [{ question: reply.prompt, answer: reply.answer }] })]) {
    writeFileSync(file, saved);
    const session = new ConversationSession(cwd, () => 1_000_000);
    assert.equal(session.threadId, null);
    assert.equal(session.canRestorePrevious, false);
    assert.deepEqual(session.currentExchanges, []);
  }
});

test('old copies are migrated to metadata only and never supply displayed messages', t => {
  const { cwd, file } = fixture(t);
  writeFileSync(file, JSON.stringify({ threadId: firstId, lastAnswerAt: 1_000_000,
    exchanges: [{ question: 'Local copy', answer: 'Must not be used' }] }));
  const session = new ConversationSession(cwd, () => 1_000_000);
  assert.equal(session.threadId, firstId);
  assert.deepEqual(session.currentExchanges, []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { threadId: firstId, lastAnswerAt: 1_000_000 });
});

test('restart restores visible messages with their context, including undo after expiry', t => {
  const { cwd } = fixture(t);
  let now = 1_000_000;
  const session = new ConversationSession(cwd, () => now);
  session.threadId = firstId;
  session.answered(reply);
  session.answered({ prompt: 'Drugie pytanie', answer: 'Druga odpowiedź' });
  const expected = [{ question: reply.prompt, answer: reply.answer },
    { question: 'Drugie pytanie', answer: 'Druga odpowiedź' }];
  const restarted = new ConversationSession(cwd, () => now);
  assert.equal(restarted.threadId, firstId);
  assert.deepEqual(restarted.currentExchanges, [], 'Messages must come from Codex');
  restarted.loadHistory(firstId, expected);
  assert.deepEqual(restarted.currentExchanges, expected);
  now += 120_000;
  const expired = new ConversationSession(cwd, () => now);
  assert.equal(expired.threadId, null);
  assert.deepEqual(expired.currentExchanges, []);
  assert.equal(expired.canRestorePrevious, false, 'Undo stays disabled until Codex messages are loaded');
  expired.loadHistory(firstId, expected);
  assert.equal(expired.canRestorePrevious, true);
  assert.equal(expired.restorePrevious(), true);
  assert.equal(expired.threadId, firstId);
  assert.deepEqual(expired.currentExchanges, expected);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(cwd, '.chatgpt-button-session.json'), 'utf8'))).sort(), ['lastAnswerAt', 'threadId']);
});

test('undo restores expired and reset conversations, renews their deadline, and can switch back', t => {
  const { cwd, file } = fixture(t);
  let now = 1_000_000;
  const session = new ConversationSession(cwd, () => now);
  assert.equal(session.restorePrevious(), false);
  session.threadId = firstId;
  session.answered(reply);
  now += 120_000;
  session.expire();
  assert.equal(session.canRestorePrevious, true);
  session.reset();
  assert.equal(session.restorePrevious(), true);
  assert.equal(session.threadId, firstId);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastAnswerAt, now);
  session.expire();
  assert.equal(session.threadId, firstId);
  session.reset();
  session.threadId = secondId;
  session.answered(reply);
  assert.equal(session.restorePrevious(), true);
  assert.equal(session.threadId, firstId);
  assert.equal(session.restorePrevious(), true);
  assert.equal(session.threadId, secondId);
});

test('empty threads cannot be restored or become the return destination', t => {
  const { cwd } = fixture(t);
  const session = new ConversationSession(cwd);
  assert.equal(session.canRestorePrevious, false);
  session.threadId = firstId;
  session.reset();
  assert.equal(session.canRestorePrevious, false, 'A thread opened without an answer is empty');
  assert.equal(session.restorePrevious(), false);

  session.threadId = firstId;
  session.answered(reply);
  session.reset();
  assert.equal(session.canRestorePrevious, true);
  session.threadId = secondId;
  assert.equal(session.restorePrevious(), true, 'A populated previous thread can be restored from an empty current thread');
  assert.equal(session.threadId, firstId);
  assert.equal(session.canRestorePrevious, false, 'The empty thread left behind must not enable undo');
  assert.equal(session.restorePrevious(), false);

  session.reset();
  session.threadId = secondId;
  session.reset();
  assert.equal(session.canRestorePrevious, false, 'Resetting an empty conversation must not offer an older thread');
});
