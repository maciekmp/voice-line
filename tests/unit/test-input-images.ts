import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, access, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppStorage } from '../../src/app-storage.ts';
import { copyExchange, exchangeFingerprint } from '../../src/conversation-model.ts';
import { decodeHistory, encodeHistory } from '../../src/conversation-format.ts';
import { exchangeSchema, conversationViewSchema } from '../../src/conversation-schemas.cjs';
import { buildHistoryContext, localContextPrompt } from '../../src/conversation-context.ts';
import { ConversationRetention, HISTORY_TTL_MS } from '../../src/conversation-retention.ts';
import { realtimePrompt } from '../../src/codex-realtime.ts';
import { storageCoordinator } from '../../src/storage-coordinator.ts';

const { conversationMarkdown } = createRequire(import.meta.url)('../../src/conversation-export.cjs');
const id = '11111111-1111-1111-1111-111111111111';
const input = { id: 'a'.repeat(64), alt: 'Załączone zdjęcie' };
const output = { id: 'b'.repeat(64), alt: 'Wygenerowany obraz' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
async function directory(t: { after: (work: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'voice-input-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('input references validate, copy independently and survive versioned history roundtrip', () => {
  const exchange = { id: 'exchange_1', revision: 1, question: 'Co widać?', answer: 'Zdjęcie.', inputImages: [{ ...input }], images: [{ ...output }] };
  assert.equal(exchangeSchema.safeParse(exchange).success, true);
  for (const images of [[null], [{ id: '../file', alt: 'bad' }], [{ id: input.id, alt: null }]]) {
    assert.equal(exchangeSchema.safeParse({ ...exchange, inputImages: images }).success, false);
  }
  assert.equal(conversationViewSchema.safeParse({ id, revision: 1, completed: [exchange], pending: { ...exchange } }).success, true);
  const copy = copyExchange(exchange); copy.inputImages![0].alt = 'changed';
  assert.equal(exchange.inputImages[0].alt, input.alt);
  const decoded = decodeHistory(JSON.parse(encodeHistory(id, 1, [exchange])), id);
  assert.deepEqual(decoded.exchanges, [exchange]);
});

test('old exchange fingerprints remain stable without inputs, while input changes conflict', () => {
  const exchange = { question: 'Q', answer: 'A', images: [output], interrupted: true };
  const oldFingerprint = createHash('sha256').update(JSON.stringify(['Q', 'A', [[output.id, output.alt]], null, 'interrupted'])).digest('hex');
  assert.equal(exchangeFingerprint(exchange), oldFingerprint);
  assert.equal(exchangeFingerprint({ ...exchange, inputImages: [] }), oldFingerprint);
  assert.notEqual(exchangeFingerprint({ ...exchange, inputImages: [input] }), oldFingerprint);
  assert.notEqual(exchangeFingerprint({ ...exchange, inputImages: [input] }), exchangeFingerprint({ ...exchange, inputImages: [{ ...input, alt: 'changed' }] }));
});

test('committed inputs persist through restart and restore with retention and idempotent receipts', async t => {
  const root = await directory(t), storage = createAppStorage('local', root);
  storage.session.threadId = id;
  const reply = { exchangeId: 'with_input', prompt: 'Opisz', answer: 'Opis', inputImages: [{ ...input }], images: [output] };
  await storage.commitReply(reply);
  reply.inputImages[0].alt = 'changed by caller';
  assert.equal(storage.session.currentExchanges[0].inputImages![0].alt, input.alt);
  const restarted = createAppStorage('local', root);
  const original = { ...reply, inputImages: [input] };
  await restarted.commitReply(original);
  assert.equal(restarted.session.currentExchanges.length, 1);
  await assert.rejects(restarted.commitReply(reply), /Conflicting conversation exchange ID/);
  const retained = JSON.parse(await readFile(join(storage.home, 'history-index.json'), 'utf8'))[id].images;
  assert.deepEqual(new Set(retained), new Set([input.id, output.id]));
  restarted.session.reset();
  const afterReset = createAppStorage('local', root);
  assert.equal(await afterReset.restorePrevious(), true);
  assert.deepEqual(afterReset.session.currentExchanges[0].inputImages, [input]);
});

test('interrupted fragments register input images in the same durable transaction', async t => {
  const root = await directory(t), storage = createAppStorage('local', root);
  storage.session.threadId = id;
  const checkpoint = { id, exchanges: [] };
  const fragment = { exchangeId: 'fragment', prompt: 'Opisz', answer: 'Fragment', inputImages: [{ ...input }] };
  storage.interruptTurn(checkpoint, fragment);
  fragment.inputImages[0].alt = 'mutated';
  const restarted = createAppStorage('local', root);
  assert.equal(restarted.session.currentExchanges[0].interrupted, true);
  assert.deepEqual(restarted.session.currentExchanges[0].inputImages, [input]);
  const retained = JSON.parse(await readFile(join(storage.home, 'history-index.json'), 'utf8'))[id].images;
  assert.deepEqual(retained, [input.id]);
});

test('historical input context describes unavailable pixels without forwarding IDs or labels', () => {
  const history = [{ question: 'Opisz zdjęcie', answer: 'Widzę dom.', inputImages: [input] }];
  for (const prompt of [localContextPrompt(history, 'Co jeszcze?'), realtimePrompt(history)]) {
    assert.match(prompt, /Piksele obrazów.*nie są dostępne/);
    assert.match(prompt, /ponowne załączenie/);
    assert.ok(!prompt.includes(input.id) && !prompt.includes(input.alt));
  }
  for (const format of ['local', 'realtime'] as const) {
    const result = buildHistoryContext([{ ...history[0], question: 'Q'.repeat(4000), answer: 'A'.repeat(4000) }], format, { maxExchanges: 1, maxBytes: 256 });
    assert.ok(result.bytes <= 256);
    assert.equal(result.inputImagesUnavailable, true);
  }
  assert.deepEqual(history[0].inputImages, [input]);
});

test('export embeds input pixels under the question and output pixels under the answer', async t => {
  const root = await directory(t), images = join(root, 'images'); await mkdir(images);
  for (const image of [input, output]) await writeFile(join(images, `${image.id}.png`), png);
  const markdown = await conversationMarkdown([{ question: 'Opisz', answer: 'Opis', inputImages: [input], images: [output] }], images);
  assert.ok(markdown.indexOf(`![${input.alt}]`) < markdown.indexOf('## Asystent'));
  assert.ok(markdown.indexOf(`![${output.alt}]`) > markdown.indexOf('## Asystent'));
  assert.equal(markdown.match(/data:image\/png;base64,/g)?.length, 2);
});

test('fresh input references protect shared blobs when an older conversation expires', async t => {
  const root = await directory(t), storage = createAppStorage('local', root);
  storage.session.threadId = id;
  await storage.commitReply({ prompt: 'Opisz', answer: 'Opis', inputImages: [input] });
  await mkdir(join(root, 'images')); await writeFile(join(root, 'images', `${input.id}.png`), png);
  const olderId = '22222222-2222-2222-2222-222222222222';
  const older = new ConversationRetention(join(root, 'imagegen-codex'), root, () => Date.now() - HISTORY_TTL_MS - 1);
  older.touch(olderId, [input]);
  const cleaner = new ConversationRetention(join(root, 'imagegen-codex'), root);
  assert.deepEqual(await cleaner.prune(async () => {}), [olderId]);
  await access(join(root, 'images', `${input.id}.png`));
});

test('a selected input lease protects an uncommitted image beyond the orphan grace period', async t => {
  const root = await directory(t), images = join(root, 'images'); await mkdir(images);
  const file = join(images, `${input.id}.png`);
  await writeFile(file, png); await utimes(file, 0, 0);
  const release = storageCoordinator(root).lease(`input-image:${input.id}`);
  t.after(release);
  const retention = new ConversationRetention(join(root, 'local-codex'), root);
  await retention.prune(async () => assert.fail('Uncommitted input has no provider thread'));
  assert.equal(retention.cleanupHealth.state, 'deferred');
  await access(file);
  release();
  await retention.prune(async () => assert.fail('Uncommitted input has no provider thread'));
  await assert.rejects(access(file), { code: 'ENOENT' });
});
