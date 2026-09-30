import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './process.ts';

const INSTRUCTIONS = 'Jesteś asystentem głosowym. Nie uruchamiaj narzędzi, nie czytaj ani nie zmieniaj plików. Dostajesz surową transkrypcję po polsku. Najpierw popraw ją do zwięzłego pytania: usuń wypełniacze, powtórzenia i wycofane fragmenty, uwzględnij ostatnią samokorektę. Następnie odpowiedz po polsku, krótko i naturalnie, korzystając z kontekstu rozmowy. Zwróć JSON z polami prompt (poprawione pytanie) i answer (tekst do wypowiedzenia). Jeśli transkrypcja jest niezrozumiała, poproś o powtórzenie zamiast zgadywać. Surowa transkrypcja:\n';
const schemaPath = fileURLToPath(new URL('./response.schema.json', import.meta.url));
type Turn = { text: string; threadId?: string; startupMs?: number; turnMs?: number };
export type VoiceReply = { prompt: string; answer: string; startupMs?: number; turnMs?: number };

export class CodexClient {
  private threadId: string | null = null;
  private active: ReturnType<typeof launch> | null = null;
  private readonly cwd: string;
  private readonly executable: string;
  private readonly sessionFile: string;
  constructor(cwd: string, executable = 'codex.cmd') {
    this.cwd = cwd; this.executable = executable;
    this.sessionFile = join(cwd, '.chatgpt-button-session.json');
    if (existsSync(this.sessionFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.sessionFile, 'utf8')).threadId;
        if (typeof saved === 'string' && /^[a-f\d-]{36}$/i.test(saved)) this.threadId = saved;
      } catch { /* A corrupt session file starts a new conversation. */ }
    }
  }
  start(): Promise<void> { return Promise.resolve(); }
  stop(): void { this.cancel(); }
  reset(): void { this.cancel(); this.threadId = null; if (existsSync(this.sessionFile)) unlinkSync(this.sessionFile); }
  cancel(): void { this.active?.kill(); this.active = null; }
  get currentThreadId(): string | null { return this.threadId; }
  async respond(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    const model = process.env.CODEX_MODEL?.trim();
    const modelArgs = model ? ['-m', model] : [];
    const args = this.threadId
      ? ['exec', 'resume', ...modelArgs, '--json', '--output-schema', schemaPath, '--skip-git-repo-check', this.threadId, '-']
      : ['exec', ...modelArgs, '--json', '--output-schema', schemaPath, '--skip-git-repo-check', '-s', 'read-only', '-'];
    const result = await this.run(args, INSTRUCTIONS + raw, signal);
    let reply: VoiceReply;
    try { reply = JSON.parse(result.text); }
    catch { throw new Error(`Codex returned invalid JSON: ${result.text}`); }
    if (typeof reply.prompt !== 'string' || typeof reply.answer !== 'string' || !reply.answer.trim()) throw new Error('Codex returned an incomplete voice reply');
    if (result.threadId) {
      this.threadId = result.threadId;
      writeFileSync(this.sessionFile, JSON.stringify({ threadId: result.threadId }), 'utf8');
    }
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
