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
import { LocalVoiceEngine } from '../../src/voice/local-engine.ts';
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
  imageItem: unknown = item;
  imageItems?: typeof item[];
  afterImage?: (index: number) => Promise<void>;
  answer = 'Gotowe.';
  auth = 'chatgpt';
  constructor(cwd: string, localHistory = false, config?: import('../../src/app-config.ts').CodexConfig) {
    super(cwd, new ConversationSession(cwd, Date.now, '.session.json', { localHistory }), true, { config });
  }
  override async start() {}
  protected override async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: this.auth } };
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: true };
    if (method === 'thread/start') return { thread: { id: threadId } };
    if (method === 'turn/start') {
      queueMicrotask(async () => {
        const emit = (method: string, params: any) => (this as any).onMessage({ method, params: { threadId, turnId, ...params } });
        if (this.includeImage) for (const [index, image] of (this.imageItems ?? [this.imageItem]).entries()) {
          emit('item/completed', { item: image });
          if (this.afterImage) await this.afterImage(index);
        }
        emit('item/completed', { item: { type: 'agentMessage', text: JSON.stringify({ prompt: 'Kwadrat', answer: this.answer }) } });
        emit('turn/completed', { turn: { id: turnId, status: 'completed' } });
      });
      return { turn: { id: turnId } };
    }
    return {};
  }
}

const falseFailure = 'Nie udało się wygenerować obrazu — narzędzie nie zwróciło wyniku.';

for (const answer of ['', ' \n\t ']) {
  test(`verified image completes and persists when the model answer is ${JSON.stringify(answer)}`, async t => {
    const cwd = await directory(t);
    const client = new FakeImageServer(cwd, true);
    client.answer = answer;
    const previews: unknown[] = [];
    const reply = await client.generateImage('Zmień obraz', undefined, 'text', undefined, images => previews.push(images));
    assert.equal(previews.length, 1);
    assert.equal(reply.answer, 'Wygenerowano obraz.');
    assert.equal(reply.images?.length, 1);
    assert.equal(client.currentExchanges.at(-1)?.answer, reply.answer);
    assert.deepEqual(new ConversationSession(cwd).readLocalHistory(client.currentThreadId!).at(-1)?.images, reply.images);
    client.includeImage = false;
    await assert.rejects(client.respond('Zwykłe pytanie'), /incomplete voice reply/);
    await assert.rejects(client.generateImage('Drugi obraz'), /nie wygenerował/);
    assert.equal(client.currentExchanges.length, 1, 'Empty text cannot become a successful answer without pixels');
  });
}

test('provider history restores verified images with empty confirmations and skips empty text-only replies', async t => {
  const cwd = await directory(t);
  const message = { type: 'agentMessage', text: '{"prompt":"Q","answer":""}' };
  const turns = [{ id: turnId, status: 'completed', items: [item, message] },
    { id: 'empty', status: 'completed', items: [message] }];
  const request = async (_method: string, params: any) => ({ thread: { id: threadId, ...(params.includeTurns && { turns }) } });
  const history = await readConversationHistory(request, threadId, cwd);
  assert.equal(history.length, 1);
  assert.equal(history[0].answer, 'Wygenerowano obraz.');
  assert.equal(history[0].images?.length, 1);
  const entries = turns.flatMap((turn, index) => turn.items.map((item, position) => ({ type: 'item', turnId: turn.id, position: index * 10 + position, item })));
  const realtime = mapRealtimeHistory(entries).history;
  assert.equal(realtime.length, 1);
  assert.equal(realtime[0].answer, 'Wygenerowano obraz.');
});

test('CLI rejects an empty answer when image metadata has no verified pixels', async t => {
  const cwd = await directory(t);
  const client = new CodexClient(cwd);
  t.mock.method(client, 'start', async () => {});
  t.mock.method(client as any, 'run', async () => ({ text: JSON.stringify({ prompt: 'Q', answer: '',
    images: [{ id: 'a'.repeat(64), alt: 'Unverified' }] }) }));
  await assert.rejects(client.respond('Q'), /incomplete voice reply/);
  assert.equal(client.currentExchanges.length, 0);
});

test('CLI fills empty image confirmations only after validating the original provider history', async t => {
  const cwd = await directory(t);
  const image = await storeGeneratedImage(cwd, item);
  const client = new CodexClient(cwd);
  t.mock.method(client, 'start', async () => {});
  const latest = { question: 'Q', answer: '', images: [image] };
  (client as any).historyServer = { readLatestExchange: async () => latest };
  t.mock.method(client as any, 'run', async () => ({ text: '{"prompt":"Q","answer":""}', threadId }));
  const reply = await client.respond('Q');
  assert.equal(reply.answer, 'Wygenerowano obraz.');
  assert.deepEqual(reply.images, [image]);
  latest.answer = 'Different raw answer';
  await assert.rejects(client.respond('Q'), /mismatched latest reply history/);
});

for (const cancel of [false, true]) {
  test(`image previews arrive before completion and ${cancel ? 'stop after cancellation' : 'commit only at completion'}`, async t => {
    const cwd = await directory(t);
    const client = new FakeImageServer(cwd, true);
    client.imageItems = [item, { ...item, result: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from([1])]).toString('base64') }];
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstPreview = new Promise<void>(resolve => { ready = resolve; });
    client.afterImage = async index => { if (index === 0) await gate; };
    const progress: import('../../src/conversation-contract.ts').GeneratedImage[][] = [];
    const controller = new AbortController();
    const work = client.generateImage('Dwa warianty', controller.signal, 'text', undefined, images => {
      progress.push(images); ready();
    });
    await firstPreview;
    assert.equal(progress.length, 1);
    assert.equal(progress[0].length, 1);
    assert.equal(client.currentExchanges.length, 0, 'A preview is not a committed answer');
    assert.deepEqual(await readImage(join(cwd, '.app-data', 'images'), progress[0][0].id), Buffer.from(png, 'base64'));
    if (cancel) controller.abort();
    release();
    if (cancel) {
      await assert.rejects(work, /Cancelled/);
      assert.equal(progress.length, 1, 'Cancelled work cannot publish the second image');
      assert.equal(client.currentExchanges.length, 0);
    } else {
      const reply = await work;
      assert.deepEqual(progress.map(images => images.length), [1, 2]);
      assert.deepEqual(reply.images, progress[1]);
      assert.deepEqual(client.currentExchanges.at(-1)?.images, reply.images);
    }
  });
}

for (const source of ['text', 'voice'] as const) {
  test(`LOCAL ${source} penguin request uses CODEX_IMAGE_MODEL and keeps four variants`, async t => {
    const cwd = await directory(t);
    const client = new FakeImageServer(cwd, true, {
      mode: 'app-server', model: 'conversation-model', imageModel: 'configured-image-model', effort: 'low',
    });
    client.imageItems = [1, 2, 3, 4].map(index => ({ ...item,
      result: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from([index])]).toString('base64') }));
    const request = 'Wygeneruj obraz pingwina w 4 wariantach';
    const engine = new LocalVoiceEngine(client,
      { start: async () => {}, stop() {}, transcribe: async () => request },
      { start: async () => {}, stop() {}, shutdown() {}, speak: async () => true });
    const reply = source === 'text' ? await engine.respond(request)
      : await engine.respondAudio('speech.wav', undefined, {}, { playback: false });
    const turn = client.calls.find(call => call.method === 'turn/start')!.params;
    assert.equal(turn.model, 'configured-image-model');
    assert.ok(turn.input[0].text.includes(request));
    assert.equal(reply.images?.length, 4);
    assert.equal(reply.questionSource, source);
  });
}

test('CLI publishes a ready image while the generation process is still running', async t => {
  const cwd = await directory(t);
  const second = { ...item, result: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from([1])]).toString('base64') };
  const script = join(cwd, 'image-stream.cjs');
  await writeFile(script, `
    const { existsSync } = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({ type: 'item.completed', item: ${JSON.stringify(item)} }));
      const timer = setInterval(() => {
        if (!existsSync('continue')) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: 'item.completed', item: ${JSON.stringify(second)} }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"prompt":"Q","answer":"Gotowe"}' } }));
      }, 10);
    });
  `);
  const client = new CodexClient(cwd, process.execPath);
  t.after(() => client.stop());
  const previews: import('../../src/conversation-contract.ts').GeneratedImage[][] = [];
  let ready!: () => void;
  const first = new Promise<void>(resolve => { ready = resolve; });
  let completed = false;
  const work = (client as any).run([script], 'prompt', undefined, undefined,
    (images: import('../../src/conversation-contract.ts').GeneratedImage[]) => { previews.push(images); ready(); });
  void work.then(() => { completed = true; });
  await first;
  assert.equal(completed, false);
  assert.equal(previews[0].length, 1);
  await writeFile(join(cwd, 'continue'), 'continue');
  const result = await work;
  assert.deepEqual(previews.map(images => images.length), [1, 2]);
  assert.deepEqual(result.images, previews[1]);
});

for (const mode of ['explicit', 'natural', 'edit'] as const) {
  test(`${mode} generation keeps all requested variants in order and in persisted history`, async t => {
    const cwd = await directory(t);
    const client = new FakeImageServer(cwd, true);
    const selected = mode === 'edit' ? await storeGeneratedImage(cwd, item) : undefined;
    // Distinct PNG fixture bytes represent separate tool results.
    const variants = [1, 2, 3].map(index => ({ ...item, id: `image-${index}`,
      result: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from([index])]).toString('base64'),
      revisedPrompt: `Wariant ${index}` }));
    client.imageItems = variants;
    const request = 'Wygeneruj trzy osobne warianty obrazu kota';
    const reply = mode === 'explicit' ? await client.generateImage(request)
      : await client.respond(request, undefined, mode === 'natural' ? 'voice' : 'text', selected?.id);
    assert.equal(reply.images?.length, 3);
    assert.equal(new Set(reply.images?.map(image => image.id)).size, 3);
    assert.deepEqual(reply.images?.map(image => image.alt), variants.map(image => image.revisedPrompt));
    for (const [index, image] of reply.images!.entries()) {
      assert.deepEqual(await readImage(join(cwd, '.app-data', 'images'), image.id), Buffer.from(variants[index].result, 'base64'));
    }
    const restored = new ConversationSession(cwd).readLocalHistory(client.currentThreadId!);
    assert.deepEqual(restored.at(-1)?.images, reply.images);
    assert.equal(reply.answer, 'Wygenerowano obrazy.');
    const input = client.calls.filter(call => call.method === 'turn/start').at(-1)!.params.input;
    assert.ok(input[0].text.includes(request));
    assert.match(input[0].text, /liczbę obrazów lub wariantów podaną przez użytkownika/);
    assert.match(input[0].text, /osobne wywołania/);
    assert.doesNotMatch(input[0].text, /dokładnie jeden obraz/);
    if (selected) assert.equal(input[1].type, 'localImage');
  });
}

test('selected image is sent as a verified localImage for editing, and never leaks into the next turn', async t => {
  const cwd = await directory(t);
  const selected = await storeGeneratedImage(cwd, item);
  const client = new FakeImageServer(cwd, true);
  const reply = await client.respond('Zmień tło', undefined, 'text', selected.id);
  assert.equal(reply.images?.length, 1);
  const edit = client.calls.filter(call => call.method === 'turn/start').at(-1)!.params;
  assert.deepEqual(edit.input[1], { type: 'localImage', path: join(cwd, '.app-data', 'images', `${selected.id}.png`) });
  assert.match(edit.input[0].text, /Sam załącznik nie oznacza prośby o edycję/);
  await client.respond('Zwykłe pytanie');
  assert.equal(client.calls.filter(call => call.method === 'turn/start').at(-1)!.params.input.length, 1);
});

test('a question about an attached image preserves the full text answer without requiring generation', async t => {
  const cwd = await directory(t);
  const selected = await storeGeneratedImage(cwd, item);
  const client = new FakeImageServer(cwd, true);
  client.includeImage = false;
  client.auth = 'apiKey';
  client.answer = 'Na obrazie widzę kwadrat. Ma jednolite tło i wyraźne krawędzie.';
  const reply = await client.respond('Co widzisz na obrazie?', undefined, 'text', selected.id);
  assert.equal(reply.answer, client.answer);
  assert.equal(reply.images, undefined);
  assert.equal(client.currentExchanges.at(-1)?.answer, client.answer);
  const turn = client.calls.find(call => call.method === 'turn/start')!.params;
  assert.equal(turn.input[1].type, 'localImage');
  assert.match(turn.input[0].text, /pełną odpowiedź tekstową w answer, bez generowania/);
  assert.ok(!client.calls.some(call => call.method === 'account/read' || call.method === 'modelProvider/capabilities/read'));
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
  for (const change of [{ status: 'failed' }, { result: '????' }, { result: '' }, { result: null }, { result: Buffer.from('not a PNG').toString('base64') }]) {
    client.imageItem = { ...item, ...change };
    await assert.rejects(client.generateImage('Kwadrat'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Codex nie wygenerował obrazu: ${falseFailure}`);
      assert.equal(codexErrorMessage(error, 'Fallback'), error.message);
      return true;
    });
    assert.equal(client.currentExchanges.length, 0);
  }
});

test('partial image failures preserve valid results and a warning in saved history', async t => {
  const cwd = await directory(t);
  const client = new FakeImageServer(cwd, true);
  client.answer = 'Narzędzie zablokowało część wyników.';
  client.imageItems = [{ ...item, status: 'failed', result: '' }, item, { ...item, result: '????' }];
  const reply = await client.generateImage('Trzy warianty');
  assert.equal(reply.images?.length, 1);
  assert.equal(reply.answer, 'Wygenerowano obraz. Nie wszystkie próby generowania zakończyły się poprawnie.');
  assert.equal(client.currentExchanges.at(-1)?.answer, reply.answer);
  assert.equal(new ConversationSession(cwd).readLocalHistory(client.currentThreadId!).at(-1)?.answer, reply.answer);
  assert.deepEqual(await readImage(join(cwd, '.app-data', 'images'), reply.images![0].id), Buffer.from(png, 'base64'));
});

test('blocked image results cannot break normal or realtime history hydration', async t => {
  const cwd = await directory(t);
  const invalid = [{ ...item, status: 'failed', result: '' }, { ...item, result: '' }, { ...item, result: '????' }];
  const message = { type: 'agentMessage', text: JSON.stringify({ prompt: 'Q', answer: falseFailure }) };
  for (const valid of [false, true]) {
    const items = [...invalid, ...(valid ? [item] : []), message];
    const mapped = mapConversationTurns([{ id: turnId, status: 'completed', items }]);
    assert.equal(mapped[0].blobs.length, valid ? 1 : 0);
    assert.equal(mapped[0].exchange.answer, falseFailure);
    await hydrateConversationExchanges(mapped, cwd);
    const realtime = mapRealtimeHistory(items.map((item, position) => ({ type: 'item', turnId, position, item })));
    assert.equal(realtime.blobs.length, valid ? 1 : 0);
    assert.equal(realtime.history.length, 1);
    assert.equal(realtime.history[0].images?.length ?? 0, valid ? 1 : 0);
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

for (const generates of [false, true]) {
  test(`realtime attachment ${generates ? 'edit keeps image links' : 'question keeps a text answer without an image task'}`, async t => {
    const cwd = await directory(t);
    const image = await storeGeneratedImage(cwd, item);
    class FakeVoice extends CodexRealtime {
      override async start() {}
      protected override async request(method: string): Promise<any> {
        if (method === 'thread/start') return { thread: { id: threadId } };
        return {};
      }
    }
    const voice = new FakeVoice(cwd);
    let received: unknown[] | undefined;
    (voice as any).imageWorker = {
      reset() {}, currentThreadId: threadId, lastImageTurnId: turnId,
      respond: async (...args: unknown[]) => {
        received = args;
        return { prompt: 'Pytanie', answer: 'Pełny opis obrazu', ...(generates && { images: [image] }) };
      },
      generateImage: async () => { throw new Error('Attachment must not force generation'); },
    };
    const reply = await voice.respond('Co widzisz na obrazie?', undefined, 'text', image.id);
    assert.deepEqual(received, ['Co widzisz na obrazie?', undefined, 'text', image.id]);
    assert.equal(reply.answer, 'Pełny opis obrazu');
    assert.equal(Boolean(reply.imageTask), generates);
    assert.equal(voice.currentExchanges.at(-1)?.answer, reply.answer);
    assert.equal((await readImageLinks(cwd, threadId)).length, generates ? 1 : 0);
  });
}

test('CLI image questions use the attached-image conversation path instead of forced generation', async t => {
  const cwd = await directory(t);
  const client = new CodexClient(cwd);
  t.mock.method(client, 'start', async () => {});
  let received: unknown[] | undefined;
  (client as any).historyServer = {
    respond: async (...args: unknown[]) => { received = args; return { prompt: 'Q', answer: 'Opis obrazu' }; },
    generateImage: async () => { throw new Error('Attachment must not force generation'); },
  };
  assert.equal((await client.respond('Co widzisz?', undefined, 'text', 'a'.repeat(64))).answer, 'Opis obrazu');
  assert.deepEqual(received, ['Co widzisz?', undefined, 'text', 'a'.repeat(64)]);
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
