import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexErrorMessage } from '../../src/codex-error.ts';

const fallback = 'Nie udało się przygotować odpowiedzi.';

test('the reported app-server usage limit displays the reset time without upgrade links', () => {
  const error = new Error('Codex turn failed: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 10:22 PM.');
  assert.equal(codexErrorMessage(error, fallback), 'Osiągnięto limit użycia Codexa. Spróbuj ponownie o 22:22.');
});

for (const [clock, expected] of [
  ['12:05 AM', '00:05'],
  ['12:05 PM', '12:05'],
  ['9:07 am', '09:07'],
  ['22:22', '22:22'],
  ['10:22 PM on October 9, 2026 UTC+2', '22:22 on October 9, 2026 UTC+2'],
]) {
  test(`preserves reset details for ${clock}`, () => {
    assert.equal(codexErrorMessage(new Error(`Codex failed (1): You\'ve hit your usage limit. Try again at ${clock}.`), fallback), `Osiągnięto limit użycia Codexa. Spróbuj ponownie o ${expected}.`);
  });
}

test('missing reset time gives a useful limit message', () => {
  assert.equal(codexErrorMessage(new Error('Codex usage limit exceeded'), fallback), 'Osiągnięto limit użycia Codexa. Sprawdź godzinę resetu w ustawieniach użycia ChatGPT.');
});

test('diagnostics after the reset time are excluded', () => {
  assert.equal(codexErrorMessage("You've hit your usage limit. Try again at 10:22 PM. More details\nstack trace", fallback), 'Osiągnięto limit użycia Codexa. Spróbuj ponownie o 22:22.');
});

test('unrelated and unknown errors retain the original fallback', () => {
  for (const error of [new Error('Codex app-server exited'), new Error('Try again at 10:22 PM.'), null, undefined, {}]) {
    assert.equal(codexErrorMessage(error, fallback), fallback);
  }
});
