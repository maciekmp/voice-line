import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AudioLevels } from '../../src/audio/levels.ts';

test('PCM metering preserves sample alignment across arbitrary pipe chunks', () => {
  const pcm = Buffer.alloc(2560);
  for (let i = 1280; i < pcm.length; i += 2) pcm.writeInt16LE(i % 4 ? 16000 : -16000, i);
  const full = new AudioLevels(16000); full.push(pcm);
  const split = new AudioLevels(16000);
  for (let i = 0; i < pcm.length; i += 137) split.push(pcm.subarray(i, i + 137));
  assert.deepEqual(split.values, full.values);
  assert.deepEqual(full.values, [0, 1]);
});

test('quiet voice has lower activity than emphatic voice', () => {
  const meter = new AudioLevels(16000);
  for (const value of [0, 500, 3000, 15000]) {
    const chunk = Buffer.alloc(1280);
    for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16LE(value, i);
    meter.push(chunk);
  }
  assert.equal(meter.values[0], 0);
  for (let i = 1; i < meter.values.length; i++) assert.ok(meter.values[i] > meter.values[i - 1]);
});

test('live windows are 20ms while playback retains its 40ms timing', () => {
  const live = new AudioLevels(16000, 20);
  const playback = new AudioLevels(16000);
  const pcm = Buffer.alloc(640);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  assert.equal(live.push(pcm).length, 1);
  assert.equal(playback.push(pcm).length, 0);
  assert.equal(playback.push(pcm).length, 1);
  assert.equal(playback.windowMs, 40);
});
