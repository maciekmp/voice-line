import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { launch } from './process.ts';
import { ConversationSession } from './conversation-session.ts';
import { readConversationHistory, readLatestConversationExchange } from './conversation-history.ts';
import type { VoiceReply } from './codex.ts';
import { LOCAL_INSTRUCTIONS } from './codex.ts';
import { storeGeneratedImage } from './image-artifacts.ts';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('./response.schema.json', import.meta.url)), 'utf8'));

type RpcReply = { id: number; result?: any; error?: { message?: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type ActiveTurn = {
  threadId: string;
  id?: string;
  text: string;
  images: any[];
  cancelled: boolean;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class CodexAppServer {
  private readonly cwd: string;
  protected readonly session: ConversationSession;
  protected readonly threadHistoryMode: 'paginated' | undefined = undefined;
  protected readonly responseInstructions: string = LOCAL_INSTRUCTIONS;
  private readonly model = process.env.CODEX_MODEL?.trim() || undefined;
  private child: ReturnType<typeof launch> | null = null;
  private startup: Promise<void> | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private turn: ActiveTurn | null = null;
  private diagnostics = '';
  lastImageTurnId: string | null = null;
  private readonly historyOnly: boolean;
  private readonly connection: { home?: string; apiKey?: string };

  constructor(cwd: string, session = new ConversationSession(cwd), historyOnly = false, connection: { home?: string; apiKey?: string } = {}) {
    this.cwd = cwd;
    this.session = session;
    this.historyOnly = historyOnly;
    this.connection = connection;
  }

  get currentThreadId(): string | null { return this.session.threadId; }
  get currentExchanges() { return this.session.currentExchanges; }
  get canRestorePrevious(): boolean { return this.session.canRestorePrevious; }
  expireConversation(): void { this.session.expire(); }
  async restorePrevious(signal?: AbortSignal): Promise<boolean> {
    await this.start();
    const id = this.session.previousConversationId;
    if (!id) return false;
    const exchanges = await this.readHistory(id);
    if (signal?.aborted || this.session.previousConversationId !== id) return false;
    this.session.loadHistory(id, exchanges);
    if (!this.session.canRestorePrevious) return false;
    if (!this.historyOnly) await this.request('thread/resume', { threadId: id, ...(this.model && { model: this.model }) });
    if (signal?.aborted || this.session.previousConversationId !== id) return false;
    const restored = this.session.restorePrevious();
    return restored;
  }

  protected readHistory(threadId: string) {
    return readConversationHistory((method, params) => this.request(method, params), threadId, this.cwd);
  }
  async readImageTurn(threadId: string, turnId: string) {
    await this.start();
    return readConversationHistory((method, params) => this.request(method, params), threadId, this.cwd, turnId);
  }
  async readLatestExchange(threadId: string) {
    await this.start();
    return readLatestConversationExchange((method, params) => this.request(method, params), threadId, this.cwd);
  }
  async requireChatGPTImageAuth(): Promise<void> {
    await this.start();
    const account = await this.request('account/read', {});
    if (account?.account?.type !== 'chatgpt') throw new Error('ImageGen wymaga logowania ChatGPT w Codex. Uruchom codex login.');
  }

  private async hydrateSavedHistory(): Promise<void> {
    for (const id of [this.session.threadId, this.session.previousConversationId]) {
      if (id) this.session.loadHistory(id, await this.readHistory(id));
    }
    if (this.session.threadId && !this.session.currentExchanges.length) this.session.reset();
  }

  start(): Promise<void> {
    if (!this.startup) this.startup = this.open().catch(error => { this.startup = null; throw error; });
    return this.startup;
  }

  private async open(): Promise<void> {
    if (this.connection.home) await mkdir(this.connection.home, { recursive: true });
    const child = launch('codex.cmd', ['app-server', '--listen', 'stdio://'], { cwd: this.cwd,
      ...(this.connection.home && { env: { CODEX_HOME: this.connection.home, CODEX_SQLITE_HOME: this.connection.home, CODEX_ACCESS_TOKEN: undefined } }),
    });
    this.child = child;
    child.stderr.setEncoding('utf8').on('data', chunk => this.diagnostics = (this.diagnostics + chunk).slice(-4000));
    createInterface({ input: child.stdout }).on('line', line => this.onLine(line));
    child.once('error', error => { if (this.child === child) this.onExit(error); });
    child.once('close', code => { if (this.child === child) this.onExit(new Error(`Codex app-server exited (${code}): ${this.diagnostics}`)); });
    try {
      await this.request('initialize', { clientInfo: { name: 'chatgpt_button', title: 'ChatGPT Button', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
      // API credentials belong to the dedicated realtime home, never the user's ChatGPT login.
      if (this.connection.apiKey) await this.request('account/login/start', { type: 'apiKey', apiKey: this.connection.apiKey });
      await this.hydrateSavedHistory();
      if (!this.historyOnly) await this.openThread();
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  protected async openThread(): Promise<void> {
    this.session.expire();
    let reply: any;
    if (this.session.threadId) {
      try { reply = await this.request('thread/resume', { threadId: this.session.threadId, ...(this.model && { model: this.model }) }); }
      catch { this.session.reset(); }
    }
    if (!reply) reply = await this.request('thread/start', { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(this.threadHistoryMode && { historyMode: this.threadHistoryMode }), ...(this.model && { model: this.model }) });
    const id = reply?.thread?.id;
    if (typeof id !== 'string') throw new Error('Codex app-server returned no thread ID');
    this.session.threadId = id;
  }

  private send(message: object): void {
    if (!this.child || this.child.exitCode !== null || this.child.stdin.destroyed) throw new Error(`Codex app-server is unavailable: ${this.diagnostics}`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  protected request(method: string, params: object): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30_000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
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
    this.onNotification(message.method, message.params);
    const turn = this.turn;
    if (!turn || message.params?.threadId !== turn.threadId) return;
    if (turn.id && message.params.turnId && message.params.turnId !== turn.id) return;
    if (message.method === 'item/completed' && message.params.item?.type === 'imageGeneration') {
      turn.images.push(message.params.item);
    }
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
    this.onServerExit(error);
  }

  protected onNotification(_method: string, _params: any): void {}
  protected onServerExit(_error: Error): void {}

  async respond(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    return this.runTurn(raw, signal, false);
  }

  async generateImage(raw: string, signal?: AbortSignal): Promise<VoiceReply> {
    await this.requireChatGPTImageAuth();
    if (!(await this.request('modelProvider/capabilities/read', {})).imageGeneration) {
      throw new Error('ImageGen nie jest dostępny dla tego połączenia Codex.');
    }
    return this.runTurn(raw, signal, true);
  }

  private async runTurn(raw: string, signal: AbortSignal | undefined, image: boolean): Promise<VoiceReply> {
    await this.start();
    if (this.turn) await this.turn.completion.catch(() => {});
    if (signal?.aborted) throw new Error('Cancelled');
    this.session.expire();
    // CLI can create/resume this session through another Codex process.
    if (this.historyOnly && this.session.threadId) await this.request('thread/resume', { threadId: this.session.threadId });
    if (!this.session.threadId) await this.openThread();
    if (!this.session.threadId) throw new Error('Codex thread is unavailable');
    if (signal?.aborted) throw new Error('Cancelled');
    let resolve!: () => void, reject!: (error: Error) => void;
    const completion = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    void completion.catch(() => {});
    const turn: ActiveTurn = { threadId: this.session.threadId, text: '', images: [], cancelled: false, completion, resolve, reject };
    this.turn = turn;
    const abort = () => {
      turn.cancelled = true;
      if (turn.id) void this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.id }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    const startedAt = performance.now();
    const timeout = setTimeout(() => { abort(); turn.reject(new Error('Codex response timed out')); }, 300_000);
    try {
      const reply = await this.request('turn/start', {
        threadId: turn.threadId,
        input: [{ type: 'text', text: image
          ? 'Wygeneruj dokładnie jeden obraz zgodny z prośbą, używając wyłącznie wbudowanego narzędzia generowania obrazów. Nie używaj shell, MCP ani innych narzędzi. Nie czytaj ani nie zmieniaj plików projektu. Nie zastępuj obrazu opisem ani kodem SVG. Po wygenerowaniu zwróć JSON z polami prompt (prośba użytkownika) i answer (bardzo krótkie potwierdzenie po polsku). Prośba użytkownika:\n' + raw
          : this.responseInstructions + raw }],
        ...(image ? { model: process.env.CODEX_IMAGE_MODEL?.trim() || 'gpt-6.1-sol' } : this.model && { model: this.model }),
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
      if (image && !turn.images.length) throw new Error(`Codex nie wygenerował obrazu: ${parsed.answer}`);
      if (turn.images.length) {
        parsed.images = await Promise.all(turn.images.map(item => storeGeneratedImage(this.cwd, item)));
        if (signal?.aborted || turn.cancelled) throw new Error('Cancelled');
        this.lastImageTurnId = turn.id;
      }
      this.session.answered(parsed);
      return { ...parsed, startupMs, turnMs: performance.now() - startedAt - startupMs };
    } finally {
      clearTimeout(timeout);
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

  stop(): void {
    this.cancel();
    const child = this.child;
    this.onExit(new Error('Codex app-server stopped'));
    child?.kill();
  }
}
