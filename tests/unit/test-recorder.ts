import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Recorder } from '../../src/audio/recorder.ts';

class TestRecorder extends Recorder {
  args: string[] = [];
  child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { return true; },
  });
  protected override launchCapture(args: string[]): ChildProcessWithoutNullStreams {
    this.args = args;
    return this.child as unknown as ChildProcessWithoutNullStreams;
  }
}

function pcm(value: number): Buffer {
  const data = Buffer.alloc(640); // 20 ms at 16 kHz, mono PCM16.
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(value, i);
  return data;
}

test('live recording reports a 20ms syllable without altering saved PCM', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-recorder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = new TestRecorder('test device', directory, undefined, 'ffmpeg');
  t.after(() => recorder.shutdown());
  const levels: number[] = [];
  recorder.onLevel = value => levels.push(value);
  const ready = recorder.startCapture();
  recorder.start();
  const syllable = pcm(1000);
  recorder.child.stdout.write(syllable.subarray(0, 137));
  assert.equal(levels.length, 0);
  recorder.child.stdout.write(syllable.subarray(137));
  await ready;
  assert.equal(levels.length, 1, 'Do not wait for the old 40ms window');
  assert.ok(levels[0] > 0);
  const file = await recorder.stop();
  assert.deepEqual((await readFile(file)).subarray(44), syllable);
  assert.equal(recorder.lastDurationSeconds, .02);
  assert.equal(levels.at(-1), 0);
});

test('a batched pipe chunk preserves short syllable peaks and cancellation clears feedback', async t => {
  const recorder = new TestRecorder('test device', tmpdir(), undefined, 'ffmpeg');
  t.after(() => recorder.shutdown());
  const levels: number[] = [];
  recorder.onLevel = value => levels.push(value);
  const ready = recorder.startCapture(); recorder.start();
  recorder.child.stdout.write(Buffer.concat([pcm(3000), pcm(0)]));
  await ready;
  assert.equal(levels.length, 1, 'One IPC level per incoming pipe chunk');
  assert.ok(levels[0] > .7, 'Trailing silence cannot erase a short syllable');
  recorder.cancel();
  assert.equal(levels.at(-1), 0);
  recorder.child.stdout.write(pcm(3000));
  assert.equal(levels.length, 2, 'Cancelled capture cannot report late levels');
});
