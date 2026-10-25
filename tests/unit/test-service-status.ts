import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessReporter } from '../../src/service-status.ts';
import type { ApplicationCapabilities } from '../../src/application-contract.ts';

test('console readiness waits for text and recording together and deduplicates unchanged snapshots', () => {
  const messages: string[] = [];
  const report = createReadinessReporter(message => messages.push(message));
  const capabilities: ApplicationCapabilities = {
    text: { state: 'starting' }, recording: { state: 'starting' }, playback: { state: 'starting' },
  };
  report({ capabilities }); report({ capabilities });
  assert.equal(messages.length, 3);
  capabilities.recording.state = 'ready'; report({ capabilities });
  assert.ok(!messages.some(message => message.startsWith('Nagrywanie gotowe')));
  capabilities.text.state = 'ready'; report({ capabilities });
  capabilities.playback.state = 'ready'; report({ capabilities }); report({ capabilities });
  assert.equal(messages.filter(message => message === 'Rozmowa tekstowa gotowa.').length, 1);
  assert.equal(messages.filter(message => message.startsWith('Nagrywanie gotowe')).length, 1);
  assert.equal(messages.filter(message => message === 'Odczytywanie gotowe.').length, 1);
});

test('a fresh runtime reporter announces readiness again after retry', () => {
  const messages: string[] = [];
  const capabilities: ApplicationCapabilities = {
    text: { state: 'ready' }, recording: { state: 'disabled' }, playback: { state: 'disabled' },
  };
  for (let runtime = 0; runtime < 2; runtime++) {
    const report = createReadinessReporter(message => messages.push(message));
    report({ capabilities }); report({ capabilities });
  }
  assert.deepEqual(messages, ['Rozmowa tekstowa gotowa.', 'Rozmowa tekstowa gotowa.']);
});
