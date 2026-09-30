import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Speaker } from '../src/speaker.ts';

const directory = mkdtempSync(join(tmpdir(), 'chatgpt-button-speaker-test-'));
const script = join(directory, 'mock-speak.ps1');
const starts = join(directory, 'starts.txt');
writeFileSync(script, `
$ErrorActionPreference = 'Stop'
Add-Content -LiteralPath '${starts}' -Value 'start'
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $request = ConvertFrom-Json -InputObject $line
  if ($request.text -eq 'slow') { Start-Sleep -Milliseconds 1000 }
  [Console]::Out.WriteLine('PLAYBACK_STARTED')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 30
  [Console]::Out.WriteLine('DONE')
  [Console]::Out.Flush()
}
`, 'utf8');

const speaker = new Speaker(script);
try {
  await speaker.start();
  let markers = 0;
  assert.equal(await speaker.speak('first', undefined, () => markers++), true);
  assert.equal(await speaker.speak('second', undefined, () => markers++), true);
  assert.equal(markers, 2);
  assert.equal(readFileSync(starts, 'utf8').trim().split(/\r?\n/).length, 1);

  const controller = new AbortController();
  const cancelled = speaker.speak('slow', controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, /Cancelled/);
  await speaker.start();
  assert.equal(await speaker.speak('after interruption'), true);
  assert.equal(readFileSync(starts, 'utf8').trim().split(/\r?\n/).length, 2);
  console.log('Speaker worker reuse and interruption passed.');
} finally {
  speaker.shutdown();
  await new Promise(resolve => setTimeout(resolve, 150));
  rmSync(directory, { recursive: true, force: true });
}
