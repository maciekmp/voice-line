import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationSession } from '../src/conversation-session.ts';
import { CodexClient } from '../src/codex.ts';
import { CodexAppServer } from '../src/codex-app-server.ts';

const firstId = '11111111-1111-1111-1111-111111111111';
const secondId = '22222222-2222-2222-2222-222222222222';
const reply = { prompt: 'Pytanie', answer: 'Odpowiedź' };

function fixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'voice-line-session-'));
  const file = join(cwd, '.chatgpt-button-session.json');
  t.after(() => { if (existsSync(file)) unlinkSync(file); rmdirSync(cwd); });
  return { cwd, file };
}

test('context expires exactly 120 seconds after the answer', t => {
  const { cwd, file } = fixture(t);
  let now = 1_000_000;
  const session = new ConversationSession(cwd, () => now);
  session.threadId = firstId;
  session.answered();
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
  session.answered();
  now += 100_000;
  session.answered();
  now += 119_999;
  assert.equal(new ConversationSession(cwd, () => now).threadId, firstId);
  now++;
  assert.equal(new ConversationSession(cwd, () => now).threadId, null);
});

test('legacy, corrupt and future-dated session files do not restore context', t => {
  const { cwd, file } = fixture(t);
  for (const saved of [JSON.stringify({ threadId: firstId }), '{bad json', JSON.stringify({ threadId: firstId, lastAnswerAt: 2_000_000 })]) {
    writeFileSync(file, saved);
    assert.equal(new ConversationSession(cwd, () => 1_000_000).threadId, null);
  }
});

for (const mode of ['cli', 'app-server'] as const) {
  test(`${mode} resumes before expiry, creates a new thread after expiry, and failures do not renew context`, async t => {
    const { cwd, file } = fixture(t);
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    writeFileSync(file, JSON.stringify({ threadId: firstId, lastAnswerAt: now }));
    const client = mode === 'cli' ? new CodexClient(cwd) : new CodexAppServer(cwd);
    const calls: { method: string; threadId?: string }[] = [];
    let fail = false;
    if (mode === 'cli') {
      Object.assign(client, { run: async (args: string[]) => {
        calls.push({ method: args.includes('resume') ? 'resume' : 'new' });
        if (fail) throw new Error('Failed');
        return { text: JSON.stringify(reply), threadId: args.includes('resume') ? firstId : secondId };
      } });
    } else {
      Object.assign(client, {
        start: async () => {},
        request: async (method: string, params: { threadId?: string }) => {
          calls.push({ method, threadId: params.threadId });
          if (method === 'thread/start') return { thread: { id: secondId } };
          if (method === 'turn/start') {
            if (fail) throw new Error('Failed');
            const turn = (client as unknown as { turn: { text: string; resolve: () => void } }).turn;
            turn.text = JSON.stringify(reply);
            turn.resolve();
            Object.assign(client, { turn: null });
            return { turn: { id: 'turn-id' } };
          }
          throw new Error(`Unexpected request: ${method}`);
        },
      });
    }
    now += 119_999;
    await client.respond('Pierwsze pytanie');
    assert.equal(client.currentThreadId, firstId);
    assert.equal(calls[0]?.method, mode === 'cli' ? 'resume' : 'turn/start');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastAnswerAt, now);
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
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).lastAnswerAt, now);
    client.reset();
    assert.equal(client.currentThreadId, null);
    assert.equal(existsSync(file), false);
  });
}
