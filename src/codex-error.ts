/** Preserve Codex usage-limit details in the message shown to the user. */
export function codexErrorMessage(error: unknown, fallback: string): string {
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/^(?:ImageGen |Codex nie wygenerował obrazu:|Nie można odczytać obrazu)/.test(detail)) return detail;
  if (/requires OPENAI_API_KEY|realtime conversation requires API key auth/i.test(detail)) {
    return 'Tryb realtime wymaga OPENAI_API_KEY w .env i korzysta z rozliczeń API. Aby używać abonamentu ChatGPT, ustaw VOICE_MODE=local.';
  }
  if (/Invalid CODEX_REALTIME_VOICE/.test(detail)) return 'Nieprawidłowy CODEX_REALTIME_VOICE. Sprawdź listę głosów w README.';
  if (/Realtime recordings are limited/.test(detail)) return 'Nagranie jest za długie. W trybie realtime nagraj pytanie krótsze niż 60 sekund.';
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
