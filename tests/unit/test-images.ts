import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { imageRequest, storeGeneratedImage, readImageLinks } from '../../src/image-artifacts.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { CodexRealtime, mapRealtimeHistory } from '../../src/codex-realtime.ts';
import { ConversationSession } from '../../src/conversation-session.ts';
import { RealtimeVoiceEngine } from '../../src/voice/realtime-engine.ts';
import type { RealtimeCallbacks } from '../../src/codex-realtime.ts';
import { codexErrorMessage } from '../../src/codex-error.ts';
import { CodexClient } from '../../src/codex.ts';
import { readConversationHistory, readLatestConversationExchange, mapConversationTurns, hydrateConversationExchanges } from '../../src/conversation-history.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
const threadId = '11111111-1111-1111-1111-111111111111';
const turnId = '22222222-2222-2222-2222-222222222222';
const item = { type: 'imageGeneration', status: 'completed', result: png, revisedPrompt: 'Kwadrat' };
const { readImage, imagePath } = createRequire(import.meta.url)('../../electron/image-files.cjs');
async function directory(t: any) {
  const cwd = await mkdtemp(join(tmpdir(), 'voice-images-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('only explicit image commands route to ImageGen', () => {
  assert.equal(imageRequest('/image czerwony kwadrat'), 'czerwony kwadrat');
  for (const text of ['Wygeneruj obraz kota.', 'Proszę, stwórz grafikę domu', 'Narysuj obrazek', 'Generate an image of a cat']) assert.equal(imageRequest(text), text);
  for (const text of ['Jak wygenerować obraz?', 'Opisz zdjęcie', 'Wygeneruj kod', 'Obraz kota', '/image']) assert.equal(imageRequest(text), null);
});

test('PNG artifacts survive reload and renderer IPC accepts IDs only', async t => {
  const cwd = await directory(t);
  const image = await storeGeneratedImage(cwd, item);
  assert.match(image.id, /^[a-f0-9]{64}$/);
  assert.equal(image.alt, 'Kwadrat');
  assert.deepEqual(await readImage(join(cwd, '.app-data', 'images'), image.id), Buffer.from(png, 'base64'));
  assert.deepEqual(await storeGeneratedImage(cwd, item), image);
  for (const id of ['../../.env', 'file.png', '', image.id.toUpperCase()]) assert.throws(() => imagePath(cwd, id), /Invalid/);
  for (const change of [{ status: 'failed' }, { result: '????' }, { result: Buffer.from('not PNG').toString('base64') }]) {
    await assert.rejects(storeGeneratedImage(cwd, { ...item, ...change }), /ImageGen/);
  }
});

test('protocol mapping is pure and filesystem hydration is an explicit second operation', async t => {
  const cwd = await directory(t);
  const turns = [{ id: turnId, status: 'completed', items: [item,
    { type: 'agentMessage', text: '{"prompt":"Q","answer":"A"}' }] }];
  const original = structuredClone(turns);
  Object.freeze(turns[0]); Object.freeze(turns[0].items);
  const mapped = mapConversationTurns(turns);
  assert.deepEqual(turns, original);
  assert.equal(mapped[0].blobs.length, 1);
  assert.match(mapped[0].exchange.images![0].id, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(cwd), []);
  const entries = [
    { type: 'item', position: 1, turnId, item },
    { type: 'item', position: 2, turnId, item: { type: 'agentMessage', text: '{"prompt":"Q","answer":"A"}' } },
  ];
  const before = structuredClone(entries);
  const realtime = mapRealtimeHistory(entries);
  assert.deepEqual(entries, before);
  assert.equal(realtime.history[0].images![0].id, mapped[0].exchange.images![0].id);
  assert.deepEqual(await readdir(cwd), []);
  await hydrateConversationExchanges(mapped, cwd);
  assert.deepEqual(await readFile(join(cwd, '.app-data', 'images', `${mapped[0].exchange.images![0].id}.png`)), Buffer.from(png, 'base64'));
});

class FakeImageServer extends CodexAppServer {
  calls: { method: string; params: any }[] = [];
  includeImage = true;
  imageItem = item;
  answer = 'Gotowe.';
  auth = 'chatgpt';
  constructor(cwd: string, localHistory = false) { super(cwd, new ConversationSession(cwd, Date.now, '.session.json', { localHistory }), true); }
  override async start() {}
  protected override async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: this.auth } };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: true };
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        const emit = (method: string, params: any) => (this as any).onMessage({ method, params: { threadId, turnId, ...params } });
        if (this.includeImage) emit('item/completed', { item: this.imageItem });
        emit('item/completed', { item: { type: 'agentMessage', text: JSON.stringify({ prompt: 'Kwadrat', answer: this.answer }) } });
        emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
      });
      return { turn: { id: turnId } };
    }
    return {};
  }
}

const falseFailure = 'Nie udało się wygenerować obrazu — narzędzie nie zwróciło wyniku.';

test('selected image is sent as a verified localImage for editing, and never leaks into the next turn', async t => {
  const cwd = await directory(t);
  const selected = await storeGeneratedImage(cwd, item);
  const client = new FakeImageServer(cwd, true);
  const reply = await client.respond('Zmień tło', undefined, 'text', selected.id);
  assert.equal(reply.images?.length, 1);
  const edit = client.calls.filter(call => call.method === 'turn/start').at(-1)!.params;
  assert.deepEqual(edit.input[1], { type: 'localImage', path: join(cwd, '.app-data', 'images', `${selected.id}.png`) });
  assert.match(edit.input[0].text, /Edytuj załączony obraz/);
  await client.respond('Zwykłe pytanie');
  assert.equal(client.calls.filter(call => call.method === 'turn/start').at(-1)!.params.input.length, 1);
});

test('missing, invalid and malformed image attachments fail before inference', async t => {
  const cwd = await directory(t);
  const selected = await storeGeneratedImage(cwd, item);
  const client = new FakeImageServer(cwd);
  for (const id of ['../secret', 'f'.repeat(64)]) {
    await assert.rejects(client.generateImage('Zmień tło', undefined, 'text', id), /Wybrany obraz jest niedostępny/);
  }
  await writeFile(join(cwd, '.app-data', 'images', `${selected.id}.png`), 'not a PNG');
  await assert.rejects(client.generateImage('Zmień tło', undefined, 'text', selected.id), /Wybrany obraz jest niedostępny/);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('verified image overrides a false failure in explicit and ordinary turns and persisted history', async t => {
  for (const explicit of [false, true]) {
    const cwd = await directory(t);
    const client = new FakeImageServer(cwd, true);
    client.answer = falseFailure;
    const reply = explicit ? await client.generateImage('Kwadrat') : await client.respond('Zrób obrazek kotka w dżungli.');
    assert.equal(reply.answer, 'Wygenerowano obraz.');
    assert.equal(reply.images?.length, 1);
    assert.equal(client.currentExchanges[0].answer, reply.answer);
    assert.equal(new ConversationSession(cwd).readLocalHistory(client.currentThreadId!)[0].answer, reply.answer);
    client.includeImage = false;
    assert.equal((await client.respond('Pytanie')).answer, falseFailure);
    await assert.rejects(client.generateImage('Drugi'), /nie wygenerował/);
  }
});

test('invalid image results cannot become successful replies', async t => {
  const cwd = await directory(t);
  const client = new FakeImageServer(cwd);
  client.answer = falseFailure;
  for (const change of [{ status: 'failed' }, { result: '????' }]) {
    client.imageItem = { ...item, ...change };
    await assert.rejects(client.generateImage('Kwadrat'), /ImageGen/);
    assert.equal(client.currentExchanges.length, 0);
  }
});

test('CLI validates original history text before confirming verified image success', async t => {
  const cwd = await directory(t);
  const image = await storeGeneratedImage(cwd, item);
  const client = new CodexClient(cwd);
  t.mock.method(client, 'start', async () => {});
  const latest = { question: 'Kwadrat', answer: falseFailure, images: [image] };
  (client as any).historyServer = { readLatestExchange: async () => latest };
  t.mock.method(client as any, 'run', async () => ({ text: JSON.stringify({ prompt: 'Kwadrat', answer: falseFailure }), threadId }));
  assert.equal((await client.respond('Kwadrat')).answer, 'Wygenerowano obraz.');
  assert.equal(client.currentExchanges[0].answer, 'Wygenerowano obraz.');
  latest.answer = 'Inna odpowiedź';
  await assert.rejects(client.respond('Kwadrat'), /mismatched latest reply history/);
  assert.equal(client.currentExchanges.length, 1);
});

test('provider history confirms verified images without changing text-only failures', async t => {
  const cwd = await directory(t);
  const message = { type: 'agentMessage', text: JSON.stringify({ prompt: 'Kwadrat', answer: falseFailure }) };
  const turns = [
    { id: turnId, status: 'completed', items: [item, message] },
    { id: 'text', status: 'completed', items: [message] },
  ];
  const request = async (_method: string, params: any) => ({ thread: { id: threadId, ...(params.includeTurns && { turns }) } });
  assert.deepEqual((await readConversationHistory(request, threadId, cwd)).map(exchange => exchange.answer), ['Wygenerowano obraz.', falseFailure]);
  const entries = turns.flatMap((turn, index) => turn.items.map((value, position) => ({ type: 'item', position: index * 10 + position, turnId: turn.id, item: value })));
  assert.deepEqual(mapRealtimeHistory(entries).history.map(exchange => exchange.answer), ['Wygenerowano obraz.', falseFailure]);
});

test('wire image items are stored only after successful generation, never on prose-only replies or API auth', async t => {
  const cwd = await directory(t);
  const client = new FakeImageServer(cwd);
  const reply = await client.generateImage('Kwadrat');
  assert.equal(reply.images?.length, 1);
  assert.equal(client.lastImageTurnId, turnId);
  assert.equal(client.currentExchanges[0].images?.[0].id, reply.images![0].id);
  assert.equal(client.calls.find(call => call.method === 'turn/start')!.params.sandboxPolicy.type, 'readOnly');
  client.includeImage = false;
  await assert.rejects(client.generateImage('Drugi'), /nie wygenerował/);
  assert.equal(client.currentExchanges.length, 1);
  client.auth = 'apiKey';
  const before = client.calls.filter(call => call.method === 'turn/start').length;
  await assert.rejects(client.generateImage('Trzeci'), /logowania ChatGPT/);
  assert.equal(client.calls.filter(call => call.method === 'turn/start').length, before);
  const loginError = 'ImageGen wymaga logowania ChatGPT w Codex. Uruchom codex login.';
  assert.equal(codexErrorMessage(new Error(loginError), 'Fallback'), loginError);
});

test('ordinary local turns accept native ImageGen results and keep text-only replies intact', async t => {
  const cwd = await directory(t);
  const client = new FakeImageServer(cwd);
  const reply = await client.respond('Chciałbym ilustrację kwadratu. Stwórz ją dla mnie.');
  assert.equal(reply.images?.length, 1);
  const input = client.calls.find(call => call.method === 'turn/start')!.params.input[0].text;
  assert.ok(input.includes('ImageGen') && !input.includes('Nie uruchamiaj narzędzi'));
  client.includeImage = false;
  const text = await client.respond('Jak tworzy się ilustracje?');
  assert.equal(text.images, undefined);
  assert.equal(client.currentExchanges.length, 2);
});

test('CLI restores only latest turn images, never images from an older answer', async t => {
  const cwd = await directory(t);
  const message = { type: 'agentMessage', text: JSON.stringify({ prompt: 'Kwadrat', answer: 'Gotowe.' }) };
  const legacy = async (_method: string, params: any) => ({ thread: { id: threadId,
    ...(params.includeTurns && { turns: [
      { status: 'completed', items: [item, message] },
      { status: 'completed', items: [message] },
    ] }) } });
  assert.equal((await readLatestConversationExchange(legacy, threadId, cwd))!.images, undefined);
  const calls: string[] = [];
  const paginated = async (method: string, params: any) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: threadId, historyMode: 'paginated' } };
    if (method === 'thread/turns/list') { assert.equal(params.limit, 1); assert.equal(params.sortDirection, 'desc'); return { data: [{ id: turnId, status: 'completed' }] }; }
    assert.equal(params.turnId, turnId);
    return { data: [{ item }, { item: message }] };
  };
  const latest = await readLatestConversationExchange(paginated, threadId, cwd);
  assert.equal(latest!.images?.length, 1);
  const client = new CodexClient(cwd);
  t.mock.method(client, 'start', async () => {});
  (client as any).historyServer = { readLatestExchange: async () => latest };
  t.mock.method(client as any, 'run', async (_args: string[], input: string) => {
    assert.ok(input.includes('ImageGen'));
    return { text: message.text, threadId };
  });
  assert.equal((await client.respond('Kwadrat')).images?.[0].id, latest!.images![0].id);
  assert.equal(client.currentExchanges[0].images?.length, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.respond('Anulowany', controller.signal), /Cancelled/);
  assert.equal(client.currentExchanges.length, 1);
});

test('API image task history restores at its position from metadata-only links', async t => {
  const cwd = await directory(t);
  const image = await storeGeneratedImage(cwd, item);
  class FakeVoice extends CodexRealtime {
    override async start() {}
    protected override async request(method: string): Promise<any> {
      if (method === 'thread/start') return { thread: { id: threadId } };
      return { data: [{ position: 1, type: 'item', turnId: 'normal', item: { type: 'agentMessage', text: JSON.stringify({ prompt: 'Pytanie', answer: 'Odpowiedź' }) } }] };
    }
    history() { return this.readHistory(threadId); }
  }
  const voice = new FakeVoice(cwd);
  let cancelled = false, stopped = false;
  (voice as any).imageWorker = {
    requireChatGPTImageAuth: async () => {}, reset: () => {},
    generateImage: async () => ({ prompt: 'Kwadrat', answer: 'Gotowe.', images: [image] }),
    currentThreadId: threadId, lastImageTurnId: turnId,
    readImageTurn: async () => [{ question: 'Kwadrat', answer: 'Gotowe.', images: [image] }],
    cancel: () => { cancelled = true; }, stop: () => { stopped = true; },
  };
  await voice.generateImage('Kwadrat');
  assert.deepEqual(await readImageLinks(cwd, threadId), [{ threadId, turnId, anchor: 0 }]);
  const linkFile = await readFile(join(cwd, '.app-data', 'image-links', `${threadId}.json`), 'utf8');
  assert.ok(!linkFile.includes('Kwadrat') && !linkFile.includes(png));
  const restored = await voice.history();
  assert.deepEqual(restored.map(value => value.question), ['Kwadrat', 'Pytanie']);
  assert.equal(restored[0].images![0].id, image.id);
  const controller = new AbortController();
  (voice as any).imageWorker.generateImage = async () => {
    controller.abort();
    return { prompt: 'Anulowany', answer: 'Gotowe.', images: [image] };
  };
  await assert.rejects(voice.generateImage('Anulowany', controller.signal), /Cancelled/);
  assert.equal((await readImageLinks(cwd, threadId)).length, 1);
  assert.equal(voice.currentExchanges.length, 1);
  voice.cancel(); voice.stop(); assert.ok(cancelled && stopped);
  await assert.rejects(readImageLinks(cwd, '../../.env'), /Invalid/);
  await writeFile(join(cwd, '.app-data', 'image-links', `${threadId}.json`), '[{"anchor":-1}]');
  await assert.rejects(readImageLinks(cwd, threadId), /Invalid/);
});

test('voice image handoff waits for final transcription and honours user cancellation', async () => {
  for (const cancelled of [false, true]) {
    let images = 0;
    const external = new AbortController();
    const client = {
      currentThreadId: null, currentExchanges: [], canRestorePrevious: false,
      start: async () => {}, stop() {}, cancel() {}, reset() {}, expireConversation() {}, restorePrevious: async () => false,
      respond: async () => ({ prompt: '', answer: '' }),
      generateImage: async () => { images++; return { prompt: 'Obraz', answer: 'Gotowe.' }; },
      respondAudio: async (_wav: string, signal?: AbortSignal, callbacks?: RealtimeCallbacks) => {
        callbacks?.onTranscript?.('user', 'Wygeneruj obraz kota', false);
        assert.equal(signal?.aborted, false);
        if (cancelled) external.abort();
        callbacks?.onTranscript?.('user', 'Wygeneruj obraz kota', true);
        assert.equal(signal?.aborted, true);
        throw new Error('Cancelled');
      },
    };
    const engine = new RealtimeVoiceEngine(client);
    if (cancelled) await assert.rejects(engine.respondAudio('speech.wav', external.signal), /Cancelled/);
    else assert.equal((await engine.respondAudio('speech.wav', external.signal)).answer, 'Gotowe.');
    assert.equal(images, cancelled ? 0 : 1);
  }
});
