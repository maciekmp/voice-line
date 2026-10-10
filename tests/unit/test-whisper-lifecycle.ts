import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WhisperTranscriber } from '../../src/stt/transcriber.ts';

test('Whisper restarts after stop, process failures and rejected startup; stale close is ignored', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-whisper-')), model = join(root, 'model');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(model, 'mock model');
  class Transcriber extends WhisperTranscriber {
    children: any[] = [];
    failStartup = false;
    protected override launchServer(): ChildProcessWithoutNullStreams {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
        stderr: new PassThrough(), kills: 0, kill() { this.kills++; return true; } });
      this.children.push(child);
      if (this.failStartup) setImmediate(() => child.emit('error', new Error('spawn failure')));
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    protected override async http(_url: string, options: RequestInit) {
      if (this.failStartup) {
        await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      }
      return new Response('{}');
    }
  }
  const transcriber = new Transcriber('whisper-cli', model, 'pl');
  t.after(() => transcriber.stop());
  await transcriber.start(); transcriber.stop(); await transcriber.start();
  assert.equal(transcriber.children.length, 2);
  for (const event of ['error', 'exit', 'close']) {
    const previous = transcriber.children.at(-1);
    previous.emit(event, new Error('failure'));
    await transcriber.start();
    assert.equal(previous.kills, 1);
    previous.emit('close');
    await transcriber.start();
  }
  assert.equal(transcriber.children.length, 5);
  transcriber.stop(); transcriber.failStartup = true;
  await assert.rejects(transcriber.start(), /did not become ready/);
  transcriber.failStartup = false;
  await transcriber.start();
  assert.equal(transcriber.children.length, 7);
});

test('inference deadline stops the server and next transcription starts fresh; caller abort is forwarded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-whisper-')), model = join(root, 'model'), wav = join(root, 'audio.wav');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(model, 'mock model'); await writeFile(wav, 'mock wav');
  class Transcriber extends WhisperTranscriber {
    launches = 0; kills = 0; hang = true;
    protected override readonly inferenceTimeoutMs: number = 20;
    protected override launchServer(): ChildProcessWithoutNullStreams {
      this.launches++;
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { this.kills++; return true; } }) as unknown as ChildProcessWithoutNullStreams;
    }
    protected override async http(url: string, options: RequestInit) {
      if (url.endsWith('/inference') && this.hang) return new Promise<Response>((_resolve, reject) => {
        const signal = options.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return new Response(JSON.stringify({ text: ' recognized ' }));
    }
  }
  const transcriber = new Transcriber('whisper-cli', model, 'pl');
  t.after(() => transcriber.stop());
  // AbortSignal.timeout is unref'ed; keep the fixture alive as a real HTTP connection would.
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  await assert.rejects(transcriber.transcribe(wav), { name: 'TimeoutError' });
  assert.equal(transcriber.kills, 1);
  transcriber.hang = false;
  assert.equal(await transcriber.transcribe(wav), 'recognized');
  assert.equal(transcriber.launches, 2);
  transcriber.hang = true;
  const controller = new AbortController();
  const pending = transcriber.transcribe(wav, controller.signal);
  const rejected = assert.rejects(pending, /caller cancel/);
  controller.abort(new Error('caller cancel')); await rejected;
});

test('stop during port allocation cancels startup before launching a process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-whisper-')), model = join(root, 'model');
  t.after(() => rm(root, { recursive: true, force: true })); await writeFile(model, 'mock');
  class Transcriber extends WhisperTranscriber {
    protected override launchServer(): never { assert.fail('cancelled startup must not launch'); }
  }
  const transcriber = new Transcriber('whisper-cli', model, 'pl');
  const pending = transcriber.start(); transcriber.stop();
  await assert.rejects(pending, /startup stopped/);
});
