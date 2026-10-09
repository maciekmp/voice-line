import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch } from './process.ts';
import { ConversationSession } from './conversation-session.ts';
import type { GeneratedImage, ImageTask } from './image-artifacts.ts';

export const INSTRUCTIONS = 'Jesteś asystentem głosowym z oknem rozmowy. Nie uruchamiaj narzędzi, nie czytaj ani nie zmieniaj plików. Dostajesz pytanie tekstowe lub surową transkrypcję po polsku. Najpierw popraw je do zwięzłego pytania: usuń wypełniacze, powtórzenia i wycofane fragmenty, uwzględnij ostatnią samokorektę. Następnie odpowiedz po polsku, krótko i naturalnie, korzystając z kontekstu rozmowy. Zwróć JSON z polami prompt (poprawione pytanie) i answer (pełna odpowiedź do wyświetlenia). Jeśli pytanie wymaga kodu, umieść kompletny kod w blokach Markdown otoczonych potrójnymi backtickami z nazwą języka, zachowując wcięcia i nowe linie. Krótkie fragmenty kodu w zdaniu otaczaj pojedynczymi backtickami. Poza kodem używaj zwykłego tekstu. Opisz krótko rozwiązanie poza blokami kodu; bloki kodu nie będą odczytywane głosowo. Jeśli transkrypcja jest niezrozumiała, poproś o powtórzenie zamiast zgadywać. Pytanie:\n';
const schemaPath = fileURLToPath(new URL('./response.schema.json', import.meta.url));
export const LOCAL_INSTRUCTIONS = INSTRUCTIONS.replace('Nie uruchamiaj narzędzi, nie czytaj ani nie zmieniaj plików.',
  'Możesz używać wyłącznie wbudowanego narzędzia ImageGen, gdy użytkownik prosi o stworzenie obrazu. Sam rozpoznaj tę intencję niezależnie od sformułowania. Nie generuj obrazu przy pytaniach o obrazy lub o sposób ich tworzenia. Generuj jeden obraz, bez zastępowania go opisem lub SVG; po wygenerowaniu podaj krótkie potwierdzenie w answer. Jeśli narzędzie jest niedostępne lub zawiedzie, powiedz to wprost i nie twierdź, że obraz powstał. Prośba do ImageGen ma zawierać tylko bieżącą prośbę użytkownika, bez historii rozmowy. Nie używaj shell, MCP ani innych narzędzi, nie czytaj ani nie zmieniaj plików.');
type Turn = { text: string; threadId?: string; startupMs?: number; turnMs?: number };
export type VoiceReply = { prompt: string; answer: string; images?: GeneratedImage[]; imageTask?: ImageTask; startupMs?: number; turnMs?: number };

export class CodexClient {
  private readonly session: ConversationSession;
  private active: ReturnType<typeof launch> | null = null;
  private readonly cwd: string;
  private readonly executable: string;
  private historyServer: import('./codex-app-server.ts').CodexAppServer | null = null;
  private startup: Promise<void> | null = null;
  constructor(cwd: string, executable = 'codex.cmd') {
    this.cwd = cwd; this.executable = executable;
    this.session = new ConversationSession(cwd);
  }
  start(): Promise<void> {
    if (!this.startup) this.startup = this.openHistory().catch(error => { this.startup = null; throw error; });
    return this.startup;
  }
  private async openHistory(): Promise<void> {
    const { CodexAppServer } = await import('./codex-app-server.ts');
    this.historyServer = new CodexAppServer(this.cwd, this.session, true);
    await this.historyServer.start();
  }
  stop(): void { this.cancel(); this.historyServer?.stop(); }
  reset(): void { this.cancel(); this.session.reset(); }
  cancel(): void { this.active?.kill(); this.active = null; this.historyServer?.cancel(); }
  get currentThreadId(): string | null { return this.session.threadId; }
  get currentExchanges() { return this.session.currentExchanges; }
  get canRestorePrevious(): boolean { return this.session.canRestorePrevious; }
  expireConversation(): void { this.session.expire(); }
  async restorePrevious(signal?: AbortSignal): Promise<boolean> {
    await this.start();
    return this.historyServer!.restorePrevious(signal);
  }
  async generateImage(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    await this.start();
    return this.historyServer!.generateImage(raw, signal);
  }
  async respond(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    await this.start();
    this.session.expire();
    const model = process.env.CODEX_MODEL?.trim();
    const modelArgs = model ? ['-m', model] : [];
    const args = this.session.threadId
      ? ['exec', 'resume', ...modelArgs, '--json', '--output-schema', schemaPath, '--skip-git-repo-check', this.session.threadId, '-']
      : ['exec', ...modelArgs, '--json', '--output-schema', schemaPath, '--skip-git-repo-check', '-s', 'read-only', '-'];
    const result = await this.run(args, LOCAL_INSTRUCTIONS + raw, signal);
    if (signal?.aborted) throw new Error('Cancelled');
    let reply: VoiceReply;
    try { reply = JSON.parse(result.text); }
    catch { throw new Error(`Codex returned invalid JSON: ${result.text}`); }
    if (typeof reply.prompt !== 'string' || typeof reply.answer !== 'string' || !reply.answer.trim()) throw new Error('Codex returned an incomplete voice reply');
    if (result.threadId) {
      this.session.threadId = result.threadId;
    }
    // CLI JSON does not reliably carry image bytes; use the authoritative turn items.
    if (this.session.threadId) {
      const latest = await this.historyServer!.readLatestExchange(this.session.threadId);
      if (!latest || latest.question !== reply.prompt || latest.answer !== reply.answer) throw new Error('Codex returned mismatched latest reply history');
      if (latest.images?.length) reply.images = latest.images;
    }
    if (signal?.aborted) throw new Error('Cancelled');
    this.session.answered(reply);
    return { ...reply, startupMs: result.startupMs, turnMs: result.turnMs };
  }
  private run(args: string[], prompt: string, signal?: AbortSignal): Promise<Turn> {
    return new Promise((resolve, reject) => {
      const child = launch(this.executable, args, { cwd: this.cwd });
      this.active = child;
      const startedAt = performance.now();
      let turnStartedAt: number | undefined;
      let text = '', threadId: string | undefined, errors = '';
      child.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started') threadId = event.thread_id;
          if (event.type === 'turn.started' && turnStartedAt === undefined) turnStartedAt = performance.now();
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
          if (event.type === 'error') errors += `\n${event.message}`;
        } catch { /* Non-JSON diagnostics are ignored. */ }
      });
      child.stdin.end(prompt);
      const abort = () => child.kill();
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
      child.once('close', code => {
        signal?.removeEventListener('abort', abort);
        if (this.active === child) this.active = null;
        if (signal?.aborted) reject(new Error('Cancelled'));
        else if (code !== 0 || !text.trim()) reject(new Error(`Codex failed (${code}): ${errors.trim()}`));
        else resolve({ text, threadId, startupMs: turnStartedAt === undefined ? undefined : turnStartedAt - startedAt, turnMs: turnStartedAt === undefined ? undefined : performance.now() - turnStartedAt });
      });
    });
  }
}
