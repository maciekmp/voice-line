import { createInterface, clearLine, cursorTo, type Interface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { createApplicationRuntime, type ApplicationRuntime } from './application-runtime.ts';
import type { ApplicationEvent, ApplicationCommand, ApplicationSnapshot, CommandResult } from './application-contract.ts';
import type { ConversationExchange } from './conversation-contract.ts';
const require = createRequire(import.meta.url);
const { appDataDirectory } = require('./app-data.cjs');
const { imagePath } = require('./image-files.cjs');
const { saveConversation } = require('./conversation-export.cjs');

const help = `Wpisz wiadomość i naciśnij Enter. Copilot: tap — przerwij i pisz; przytrzymanie — mów.
/new — nowa rozmowa    /previous — przywróć poprzednią    /cancel — przerwij
/history — historia    /status — stan usług    /retry — uruchom usługi ponownie
/paste — tekst wielowierszowy; /send wysyła, /abort zachowuje rozmowę bez wysyłania
/save <ścieżka.md> — zapisz rozmowę z obrazami    /image <opis> — wygeneruj obraz
/help — pomoc    /quit — zakończ    Ctrl+C — przerwij pracę lub zakończ, gdy bezczynna`;
const phases = {
  starting: 'Uruchamiam rozmowę…', idle: 'Gotowe.', listening: 'Słucham… Puść Copilot, aby wysłać.',
  transcribing: 'Rozpoznaję mowę…', thinking: 'Przygotowuję odpowiedź…',
  'preparing-speech': 'Przygotowuję głos…', speaking: 'Odczytuję odpowiedź…', error: '',
};
const reasons: Record<Extract<CommandResult, { accepted: false }>['reason'], string> = {
  invalid: 'Niepoprawne polecenie lub wiadomość (limit 12000 znaków).', unavailable: 'Rozmowa nie jest jeszcze gotowa. Sprawdź /status lub użyj /retry.',
  busy: 'Trwa operacja. Użyj Copilota lub /cancel, aby ją przerwać.', 'no-previous': 'Brak poprzedniej rozmowy.',
  disconnected: 'Utracono połączenie z usługami.', timeout: 'Nie otrzymano potwierdzenia przyjęcia wiadomości.',
};

export function startCli(options: {
  input?: Readable; output?: Writable; terminal?: boolean; debug?: boolean;
  createRuntime?: (emit: (event: ApplicationEvent) => void) => ApplicationRuntime;
  save?: (filename: string, exchanges: ConversationExchange[]) => Promise<void>;
} = {}) {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const terminal = options.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let rl: Interface;
  let runtime: ApplicationRuntime | undefined;
  let snapshot: ApplicationSnapshot | undefined;
  let generation = 0;
  let closed = false;
  let restarting: Promise<void> | undefined;
  let lineTail = Promise.resolve();
  let multiline: string[] | null = null;
  let multilineRevision = 0;
  let lastStatus = '';
  let lastMessage = '';
  let exitCode = 0;
  const printed = new Map<string, string>();
  const imageDirectory = join(appDataDirectory(), 'images');
  let resolveClosed!: (code: number) => void;
  const finished = new Promise<number>(resolve => { resolveClosed = resolve; });

  function say(value: string) {
    if (closed) return;
    // Provider text cannot execute terminal control sequences (including OSC links).
    const text = stripVTControlCharacters(value).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    if (terminal) { clearLine(output, 0); cursorTo(output, 0); }
    output.write(`${text}\n`);
    if (terminal) rl?.prompt(true);
  }
  function showExchange(exchange: ConversationExchange) {
    say(`\nTy${exchange.questionSource === 'voice' ? ' (głos)' : ''}: ${exchange.question}\n\nAsystent: ${exchange.answer}${exchange.interrupted ? '\n[Odpowiedź przerwana]' : ''}`);
    for (const image of exchange.images ?? []) say(`Obraz: ${image.alt}\n${imagePath(imageDirectory, image.id)}`);
  }
  function onEvent(event: ApplicationEvent) {
    if (event.type === 'level') return;
    if (event.type === 'notice') { say(event.message); return; }
    if (event.type === 'ui') {
      if (event.action === 'correct' || event.action === 'continue') {
        multiline = null; multilineRevision++;
        if (terminal) {
          rl.write(null, { ctrl: true, name: 'u' }); rl.write(null, { ctrl: true, name: 'k' }); rl.setPrompt('Ty> ');
        }
        say(event.action === 'correct' ? 'Przerwano. Wpisz poprawione pytanie.' : 'Przerwano odczytywanie. Możesz kontynuować rozmowę.');
      } else if (event.action === 'compose') {
        say('Wpisz wiadomość lub przytrzymaj Copilot, aby mówić.');
        if (snapshot?.capabilities.recording.state !== 'ready') say(snapshot?.capabilities.recording.message || 'Nagrywanie nie jest jeszcze gotowe.');
      }
      return;
    }
    snapshot = event;
    if (!terminal && event.state === 'error') exitCode = 1;
    if (event.reset) { printed.clear(); say('Nowa rozmowa.'); }
    const status = event.state === 'thinking' && event.generatingImage ? 'Generuję obraz…' : phases[event.state];
    if (status && status !== lastStatus) { lastStatus = status; say(status); }
    const message = [event.message, ...Object.values(event.capabilities)
      .filter(capability => capability.state === 'error' || capability.state === 'disabled').map(capability => capability.message)]
      .filter(Boolean).join(' ');
    if (message && message !== lastMessage) say(message);
    lastMessage = message;
    const exchanges = event.conversation.completed;
    // Reconcile with the authoritative history: corrections and expiry remove prior entries.
    const live = new Set(exchanges.map((exchange, index) => exchange.id ?? `${event.conversation.id}:${index}`));
    for (const key of printed.keys()) if (!live.has(key)) printed.delete(key);
    exchanges.forEach((exchange, index) => {
      const key = exchange.id ?? `${event.conversation.id}:${index}`, fingerprint = JSON.stringify(exchange);
      if (printed.get(key) !== fingerprint) { showExchange(exchange); printed.set(key, fingerprint); }
    });
  }

  async function boot() {
    const currentGeneration = ++generation;
    snapshot = undefined; printed.clear(); lastStatus = ''; lastMessage = '';
    try {
      runtime = (options.createRuntime ?? (emit => createApplicationRuntime(emit, {
        debug: options.debug, keyboard: terminal, voice: terminal,
        log: { log: (...values) => { if (options.debug) say(values.join(' ')); },
          error: (...values) => { if (options.debug) say(values.map(String).join(' ')); } },
      })))(event => { if (!closed && generation === currentGeneration) onEvent(event); });
      // Starting services must not block /status, /retry, drafting or exit.
      await runtime.start().catch(error => say(`Nie udało się uruchomić usług: ${String(error)}`));
    } catch (error) {
      runtime = undefined; if (!terminal) exitCode = 1;
      say(`Nie udało się uruchomić usług: ${String(error)}. Popraw ustawienia i użyj /retry.`);
    }
  }
  async function restart() {
    if (restarting) return restarting;
    restarting = (async () => {
      ++generation;
      const previous = runtime; runtime = undefined;
      await previous?.shutdown();
      if (!closed) await boot();
    })().finally(() => { restarting = undefined; });
    return restarting;
  }
  function track(work: Promise<void>) {
    void work.catch(error => say(String(error)));
  }
  function send(command: ApplicationCommand) {
    const receipt = runtime?.dispatch(command);
    if (!receipt || !receipt.result.accepted) {
      if (!terminal) exitCode = 1;
      say(receipt && !receipt.result.accepted ? reasons[receipt.result.reason] : reasons.unavailable);
      return undefined;
    }
    track(receipt.completion);
    return receipt.completion;
  }
  async function line(value: string) {
    if (closed) return;
    const text = value.trim();
    if (multiline !== null && text !== '/send' && text !== '/abort' && text !== '/quit') {
      if (multiline.join('\n').length + value.length + 1 > 12000) say('Limit 12000 znaków. Użyj /send lub /abort.');
      else multiline.push(value);
      if (terminal) rl.prompt();
      return;
    }
    if (!text) { if (terminal) rl.prompt(); return; }
    if (text === '/quit') { await shutdown(); return; }
    if (text === '/help') say(help);
    else if (text === '/status') {
      if (!snapshot) say('Usługi nie są gotowe. Użyj /retry.');
      else {
        const services = { text: 'Rozmowa tekstowa', recording: 'Nagrywanie', playback: 'Odczytywanie' };
        const states = { starting: 'uruchamianie', ready: 'gotowe', error: 'błąd', disabled: 'wyłączone', stopped: 'zatrzymane' };
        say((Object.keys(services) as (keyof typeof services)[]).map(name => {
          const capability = snapshot!.capabilities[name];
          return `${services[name]}: ${states[capability.state]}${capability.message ? ` — ${capability.message}` : ''}`;
        }).join('\n'));
      }
    } else if (text === '/history') {
      if (!snapshot?.conversation.completed.length) say('Brak historii bieżącej rozmowy.');
      else snapshot.conversation.completed.forEach(showExchange);
    } else if (text === '/retry') await restart();
    else if (text === '/paste') {
      multiline = []; multilineRevision++; rl.setPrompt('…> '); say('Wpisz lub wklej tekst. /send wysyła, /abort odrzuca draft.');
    } else if (text === '/abort') { multiline = null; multilineRevision++; rl.setPrompt('Ty> '); say('Odrzucono draft.'); }
    else if (text.startsWith('/save ')) {
      const filename = text.slice(6).trim().replace(/^"(.*)"$/, '$1');
      const exchanges = structuredClone(snapshot?.conversation.completed ?? []);
      try {
        await (options.save ?? ((file, history) => saveConversation(file, history, imageDirectory)))(resolve(filename), exchanges);
        say(`Zapisano rozmowę: ${resolve(filename)}`);
      } catch { if (!terminal) exitCode = 1; say('Nie zapisano rozmowy. Sprawdź historię, dostępność obrazów i ścieżkę docelową.'); }
    } else if (['/new', '/previous', '/cancel'].includes(text)) {
      const completion = send({ command: text === '/new' ? 'reset' : text === '/previous' ? 'previous' : 'cancel' });
      if (!terminal) await completion;
    } else {
      const draft = text === '/send' ? multiline?.join('\n') : value;
      if (draft === undefined) { say('Najpierw użyj /paste.'); return; }
      if (text.startsWith('/') && text !== '/send' && !/^\/image\s/i.test(text)) {
        if (!terminal) exitCode = 1;
        say('Nieznane polecenie. Użyj /help.'); return;
      }
      const draftVersion = multilineRevision;
      const completion = send({ command: 'text', text: draft });
      if (completion) {
        if (draftVersion === multilineRevision) { multiline = null; rl.setPrompt('Ty> '); }
        if (!terminal) await completion;
      } else if (terminal && multiline === null && !rl.line) rl.write(draft);
      else if (multiline === null) say(`Niewysłana wiadomość: ${draft}`);
    }
    if (terminal && !closed) rl.prompt(true);
  }
  async function shutdown() {
    if (closed) return finished;
    closed = true; ++generation; rl.close();
    await runtime?.shutdown();
    await restarting;
    resolveClosed(exitCode);
  }

  rl = createInterface({ input, output, terminal, prompt: 'Ty> ', crlfDelay: Infinity });
  rl.on('line', value => {
    if (terminal) track(line(value));
    else lineTail = lineTail.then(() => line(value)).catch(error => say(String(error)));
  });
  rl.on('SIGINT', () => {
    if (snapshot && ['listening', 'transcribing', 'thinking', 'preparing-speech', 'speaking'].includes(snapshot.state)) send({ command: 'cancel' });
    else void shutdown();
  });
  rl.on('close', () => {
    if (!closed) void (async () => { if (!terminal) await lineTail; await shutdown(); })();
  });
  say(`Voice Line — konsola\n${help}`);
  const startup = boot();
  if (!terminal) lineTail = startup;
  if (terminal) rl.prompt();
  return { finished, shutdown, restart };
}
