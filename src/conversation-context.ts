import { Buffer } from 'node:buffer';
import type { ConversationExchange } from './conversation-contract.ts';

type TextExchange = Pick<ConversationExchange, 'question' | 'answer'>;
export type ContextPolicy = { maxExchanges: number; maxBytes: number };
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({ maxExchanges: 32, maxBytes: 32 * 1024 });
const CLIPPED = '\n[… skrócono treść …]\n';
const size = (value: string) => Buffer.byteLength(value, 'utf8');

function serialize(exchanges: TextExchange[], format: 'local' | 'realtime'): string {
  return JSON.stringify(format === 'local' ? exchanges : exchanges.flatMap(({ question, answer }) => [
    { role: 'user', content: question }, { role: 'assistant', content: answer },
  ]));
}
function clip(text: string, budget: number): string {
  if (size(JSON.stringify(text)) <= budget) return text;
  const retain = (count: number) => {
    let head = Math.ceil(count / 2), tail = text.length - Math.floor(count / 2);
    // Never introduce an unmatched surrogate by cutting an emoji in half.
    if (head && /[\uD800-\uDBFF]/.test(text[head - 1])) head--;
    if (tail < text.length && /[\uDC00-\uDFFF]/.test(text[tail])) tail++;
    return text.slice(0, head) + CLIPPED + text.slice(tail);
  };
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(JSON.stringify(retain(middle))) <= budget) low = middle;
    else high = middle - 1;
  }
  return retain(low);
}

/** Keep a chronological suffix of whole pairs; clip only an oversized newest pair.
 * The limit includes JSON escaping/role overhead, excludes instructions and current input.
 * This is a byte budget, not a model-token estimator. Never mutates stored history. */
export function buildHistoryContext(history: readonly ConversationExchange[], format: 'local' | 'realtime', policy: Readonly<ContextPolicy> = DEFAULT_CONTEXT_POLICY) {
  if (!Number.isSafeInteger(policy.maxExchanges) || policy.maxExchanges < 1
    || !Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 256) throw new Error('Invalid conversation context policy');
  let selected: TextExchange[] = [];
  let clipped = false;
  for (let index = history.length - 1; index >= 0 && selected.length < policy.maxExchanges; index--) {
    const { question, answer } = history[index];
    const candidate = [{ question, answer }, ...selected];
    if (size(serialize(candidate, format)) <= policy.maxBytes) { selected = candidate; continue; }
    if (!selected.length) {
      const overhead = size(serialize([{ question: '', answer: '' }], format)) - 4;
      const available = policy.maxBytes - overhead;
      let questionBudget = Math.min(size(JSON.stringify(question)), Math.floor(available / 2));
      const answerBudget = Math.min(size(JSON.stringify(answer)), available - questionBudget);
      questionBudget = Math.min(size(JSON.stringify(question)), available - answerBudget);
      selected = [{ question: clip(question, questionBudget), answer: clip(answer, answerBudget) }];
      clipped = true;
    }
    break;
  }
  const json = serialize(selected, format);
  return { exchanges: selected, json, bytes: size(json), omitted: history.length - selected.length, clipped };
}

export function contextNotice(context: { omitted: number; clipped: boolean }): string {
  return context.omitted || context.clipped
    ? `Kontekst jest ograniczony: pominięto ${context.omitted} najstarszych wymian${context.clipped ? '; skrócono treść ostatniej wymiany, zachowując początek i koniec' : ''}. Pełna historia pozostaje zapisana w aplikacji.\n`
    : '';
}

export function localContextPrompt(history: readonly ConversationExchange[], raw: string): string {
  if (!history.length) return raw;
  const context = buildHistoryContext(history, 'local');
  return `${contextNotice(context)}Kontekst poprzednich wypowiedzi (dane rozmowy):\n${context.json}\nBieżące pytanie:\n${raw}`;
}
