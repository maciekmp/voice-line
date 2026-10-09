// Optional smoke test: installed Codex + FFplay, simulated audio, no paid inference.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import assert from 'node:assert/strict';
import { CodexRealtime } from '../src/codex-realtime.ts';

const directory = await mkdtemp(join(tmpdir(), 'voice-line-wire-'));
const sockets = new Set<Duplex>();
const server = createServer();
const prompts: string[] = [];
server.on('upgrade', (request, socket) => {
  let sent = false;
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const send = (event: object) => {
    const data = Buffer.from(JSON.stringify(event));
    const header = Buffer.alloc(data.length < 126 ? 2 : 4);
    header[0] = 129;
    if (data.length < 126) header[1] = data.length;
    else { header[1] = 126; header.writeUInt16BE(data.length, 2); }
    socket.write(Buffer.concat([header, data]));
  };
  let pending = Buffer.alloc(0);
  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const masked = !!(pending[1] & 128);
      let size = pending[1] & 127, offset = 2;
      if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4; }
      if (size === 127) { if (pending.length < 10) return; size = Number(pending.readBigUInt64BE(2)); offset = 10; }
      if (size > 4 * 1024 * 1024) { socket.destroy(); return; }
      if (pending.length < offset + (masked ? 4 : 0) + size) return;
      const opcode = pending[0] & 15;
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const data = Buffer.from(pending.subarray(offset, offset + size));
      pending = pending.subarray(offset + size);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      if (opcode === 8) { socket.end(); return; }
      if (opcode !== 1) continue;
      const event = JSON.parse(data.toString());
      if (event.type === 'session.update') {
        assert.equal(typeof event.session.instructions, 'string');
        prompts.push(event.session.instructions);
        send({ type: 'session.updated', session: { id: 'session_test' } });
      }
      if (event.type === 'input_audio_buffer.append' && !sent) {
        sent = true;
        assert.ok(Buffer.from(event.audio, 'base64').length > 57600);
        send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user_test', transcript: 'Pytanie testowe.' });
        send({ type: 'response.created', response: { id: 'response_test', status: 'in_progress' } });
        send({ type: 'response.output_audio.delta', response_id: 'response_test', item_id: 'message_test', output_index: 0,
          content_index: 0, delta: Buffer.alloc(9600).toString('base64') });
        send({ type: 'response.output_audio_transcript.done', response_id: 'response_test', item_id: 'message_test', output_index: 0,
          content_index: 0, transcript: 'Test.' });
        send({ type: 'response.done', response: { id: 'response_test', status: 'completed', output: [] } });
      }
    }
  });
});

let client: CodexRealtime | undefined, restored: CodexRealtime | undefined;
const originalKey = process.env.OPENAI_API_KEY;
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const home = join(directory, '.chatgpt-button', 'realtime-codex');
  await mkdir(home, { recursive: true });
  // This override is confined to the temporary test home; it never edits user config.
  await writeFile(join(home, 'config.toml'), `experimental_realtime_ws_base_url="ws://127.0.0.1:${address.port}"\n`);
  process.env.OPENAI_API_KEY = 'test-not-a-real-api-key';
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
  const path = join(directory, 'speech.wav');
  await writeFile(path, wav);
  client = new CodexRealtime(directory);
  const transcripts: { role: string; text: string }[] = [];
  const reply = await client.respondAudio(path, undefined, { onTranscript: (role, text) => {
    assert.deepEqual(client!.currentExchanges, [], 'Text arrives before the answer is saved after playback');
    transcripts.push({ role, text });
  } });
  assert.deepEqual(reply, { prompt: 'Pytanie testowe.', answer: 'Test.' });
  assert.ok(transcripts.some(entry => entry.role === 'user' && entry.text === reply.prompt));
  assert.ok(transcripts.some(entry => entry.role === 'assistant' && entry.text === reply.answer));
  client.stop();
  await new Promise(resolve => setTimeout(resolve, 250));
  restored = new CodexRealtime(directory);
  await restored.start();
  assert.deepEqual(restored.currentExchanges, [{ question: 'Pytanie testowe.', answer: 'Test.' }]);
  await restored.respondAudio(path);
  assert.equal(prompts.length, 2);
  assert.ok(!prompts[0].includes('Pytanie testowe.'));
  assert.ok(prompts[1].includes('Pytanie testowe.'));
  assert.ok(prompts[1].includes('Test.'));
  restored.reset();
  await restored.respondAudio(path);
  assert.equal(prompts.length, 3);
  assert.ok(!prompts[2].includes('Pytanie testowe.'));
  assert.equal(await restored.restorePrevious(), true);
  await restored.respondAudio(path);
  assert.equal(prompts.length, 4);
  const history = JSON.parse(prompts[3].slice(prompts[3].lastIndexOf('\n') + 1));
  assert.equal(history.length, 4);
  assert.deepEqual(history[0], { role: 'user', content: 'Pytanie testowe.' });
  console.log('Codex v2 audio, FFplay drain and context after restart, reset and restore: passed');
} finally {
  client?.stop(); restored?.stop();
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
  for (const socket of sockets) socket.destroy();
  server.close();
  await new Promise(resolve => setTimeout(resolve, 250));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
