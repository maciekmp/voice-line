/** Preserve Codex usage-limit details in the message shown to the user. */
export function codexErrorMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!/you[’']ve hit your usage limit|usage limit (?:has been )?(?:reached|exceeded)/i.test(detail)) return fallback;

  const retryAt = /try again at\s+([^\r\n]+?)(?:\.(?:\s|$)|$)/i.exec(detail)?.[1]?.trim();
  if (!retryAt) return 'Osiągnięto limit użycia Codexa. Sprawdź godzinę resetu w ustawieniach użycia ChatGPT.';

  // Convert the clock only; retain any date or timezone supplied by Codex.
  const resetAt = retryAt.replace(/\b(1[0-2]|0?[1-9]):([0-5]\d)\s*(AM|PM)\b/i, (_, hours: string, minutes: string, period: string) => {
    const hour = Number(hours) % 12 + (period.toUpperCase() === 'PM' ? 12 : 0);
    return String(hour).padStart(2, '0') + ':' + minutes;
  });
  return 'Osiągnięto limit użycia Codexa. Spróbuj ponownie o ' + resetAt + '.';
}
