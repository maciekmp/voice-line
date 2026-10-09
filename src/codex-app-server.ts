import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './process.ts';
import { ConversationSession } from './conversation-session.ts';
import type { VoiceReply } from './codex.ts';
import { INSTRUCTIONS } from './codex.ts';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('./response.schema.json', import.meta.url)), 'utf8'));

type RpcReply = { id: number; result?: any; error?: { message?: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type ActiveTurn = {
  threadId: string;
  id?: string;
  text: string;
  cancelled: boolean;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class CodexAppServer {
  private readonly cwd: string;
  private readonly session: ConversationSession;
  private readonly model = process.env.CODEX_MODEL?.trim() || undefined;
  private child: ReturnType<typeof launch> | null = null;
  private startup: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private turn: ActiveTurn | null = null;
  private diagnostics = '';

  constructor(cwd: string) {
    this.cwd = cwd;
    this.session = new ConversationSession(cwd);
  }

  get currentThreadId(): string | null { return this.session.threadId; }

  start(): Promise<void> {
    if (!this.startup) this.startup = this.open().catch(error => { this.startup = null; throw error; });
    return this.startup;
  }

  private async open(): Promise<void> {
    const child = launch('codex.cmd', ['app-server', '--listen', 'stdio://'], { cwd: this.cwd });
    this.child = child;
    child.stderr.setEncoding('utf8').on('data', chunk => this.diagnostics = (this.diagnostics + chunk).slice(-4000));
    createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    child.once('error', error => this.onExit(error));
    child.once('close', code => this.onExit(new Error(`Codex app-server exited (${code}): ${this.diagnostics}`)));
    try {
      await this.request('initialize', { clientInfo: { name: 'chatgpt_button', title: 'ChatGPT Button', version: '0.1.0' } });
      this.send({ method: 'initialized', params: {} });
      await this.openThread();
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  private async openThread(): Promise<void> {
    this.session.expire();
    let reply: any;
    if (this.session.threadId) {
      try { reply = await this.request('thread/resume', { threadId: this.session.threadId, ...(this.model && { model: this.model }) }); }
      catch { this.session.reset(); }
    }
    if (!reply) reply = await this.request('thread/start', { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(this.model && { model: this.model }) });
    const id = reply?.thread?.id;
    if (typeof id !== 'string') throw new Error('Codex app-server returned no thread ID');
    this.session.threadId = id;
  }

  private send(message: object): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error(`Codex app-server is unavailable: ${this.diagnostics}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: object): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  private onLine(line: string): void {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      const reply = message as RpcReply;
      if (reply.error) pending.reject(new Error(`Codex ${reply.error.message ?? 'RPC error'}`));
      else pending.resolve(reply.result);
      return;
    }
    const turn = this.turn;
    if (!turn || message.params?.threadId !== turn.threadId) return;
    if (message.method === 'item/completed' && message.params.item?.type === 'agentMessage') {
      turn.text = message.params.item.text ?? turn.text;
    }
    if (message.method === 'turn/completed' && (!turn.id || message.params.turn?.id === turn.id)) {
      if (message.params.turn?.status === 'completed') turn.resolve();
      else turn.reject(new Error(`Codex turn ${message.params.turn?.status ?? 'failed'}: ${message.params.turn?.error?.message ?? ''}`));
      if (this.turn === turn) this.turn = null;
    }
  }

  private onExit(error: Error): void {
    if (!this.child) return;
    this.child = null;
    this.startup = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turn?.reject(error);
    this.turn = null;
  }

  async respond(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    await this.start();
    if (this.turn) await this.turn.completion.catch(() => {});
    if (signal?.aborted) throw new Error('Cancelled');
    this.session.expire();
    if (!this.session.threadId) await this.openThread();
    if (!this.session.threadId) throw new Error('Codex thread is unavailable');
    let resolve!: () => void, reject!: (error: Error) => void;
    const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    void completion.catch(() => {});
    const turn: ActiveTurn = { threadId: this.session.threadId, text: '', cancelled: false, completion, resolve, reject };
    this.turn = turn;
    const abort = () => {
      turn.cancelled = true;
      if (turn.id) void this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const startedAt = performance.now();
    try {
      const reply = await this.request('turn/start', {
        threadId: turn.threadId,
        input: [{ type: 'text', text: INSTRUCTIONS + raw }],
        ...(this.model && { model: this.model }),
        effort: process.env.CODEX_EFFORT ?? 'low',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        outputSchema: schema,
      });
      const startupMs = performance.now() - startedAt;
      turn.id = reply?.turn?.id;
      if (!turn.id) throw new Error('Codex app-server returned no turn ID');
      if (turn.cancelled) abort();
      await completion;
      if (turn.cancelled || signal?.aborted) throw new Error('Cancelled');
      let parsed: VoiceReply;
      try { parsed = JSON.parse(turn.text); }
      catch { throw new Error(`Codex returned invalid JSON: ${turn.text}`); }
      if (typeof parsed.prompt !== 'string' || typeof parsed.answer !== 'string' || !parsed.answer.trim()) throw new Error('Codex returned an incomplete voice reply');
      this.session.answered();
      return { ...parsed, startupMs, turnMs: performance.now() - startedAt - startupMs };
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.turn === turn && !turn.id) { this.turn = null; turn.resolve(); }
    }
  }

  cancel(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.cancelled = true;
    if (turn.id) void this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id }).catch(() => {});
  }

  reset(): void {
    this.cancel();
    this.session.reset();
    // The running server opens a new thread when the next response starts.
  }

  stop(): void { this.cancel(); this.child?.kill(); this.child = null; }
}
