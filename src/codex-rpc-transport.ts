import { createInterface, type Interface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class CodexRpcTransport {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly lines: Interface;
  private disconnected: Error | null = null;
  private diagnostics = '';
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onMessage: (message: any) => void;
  private readonly onDisconnect: (error: Error) => void;
  private readonly onServerRequest?: (method: string, params: any) => unknown | Promise<unknown>;

  constructor(child: ChildProcessWithoutNullStreams, onMessage: (message: any) => void, onDisconnect: (error: Error) => void,
    onServerRequest?: (method: string, params: any) => unknown | Promise<unknown>) {
    this.child = child;
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
    this.onServerRequest = onServerRequest;
    // Keep error handlers even after stop: write callbacks and pipe errors may arrive late.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', error => this.disconnect(error));
    child.on('error', error => this.disconnect(error));
    child.once('close', code => this.disconnect(new Error(`Codex app-server exited (${code}): ${this.diagnostics}`)));
    child.stdin.once('close', () => this.disconnect(new Error('Codex app-server input closed')));
    child.stdout.once('end', () => this.disconnect(new Error('Codex app-server output ended')));
    child.stdout.once('close', () => this.disconnect(new Error('Codex app-server output closed')));
    child.stderr.setEncoding('utf8').on('data', chunk => {
      if (!this.disconnected) this.diagnostics = (this.diagnostics + chunk).slice(-4000);
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('error', error => this.disconnect(error));
    this.lines.on('line', line => {
      if (this.disconnected) return;
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (typeof message.method === 'string') {
        if (!Object.hasOwn(message, 'id')) this.onMessage(message);
        else if (typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id))) {
          void this.serverRequest(message).catch(error => this.disconnect(error));
        }
        return;
      }
      if (typeof message.id === 'number' && !Object.hasOwn(message, 'method')
        && Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error')) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Codex ${message.error.message ?? 'RPC error'}`));
        else pending.resolve(message.result);
      }
    });
  }

  private async serverRequest(message: { id: number | string; method: string; params?: any }): Promise<void> {
    let reply: object;
    try {
      if (!this.onServerRequest) throw Object.assign(new Error(`Unsupported server method: ${message.method}`), { code: -32601 });
      reply = { id: message.id, result: await this.onServerRequest(message.method, message.params) };
    } catch (error) {
      const failure = error as Error & { code?: number };
      reply = { id: message.id, error: { code: typeof failure.code === 'number' ? failure.code : -32603,
        message: failure.message || 'Server request failed' } };
    }
    if (!this.disconnected) this.send(reply);
  }

  send(message: object): void {
    if (this.disconnected) throw this.disconnected;
    if (this.child.exitCode !== null || this.child.stdin.destroyed || !this.child.stdin.writable) {
      const error = new Error(`Codex app-server is unavailable: ${this.diagnostics}`);
      this.disconnect(error);
      throw error;
    }
    const data = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(data, error => { if (error) this.disconnect(error); });
    } catch (error) {
      this.disconnect(error as Error);
      throw error;
    }
  }

  request(method: string, params: object, timeoutMs = 30_000): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      try { this.send({ id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private disconnect(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = error;
    this.lines?.close();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    // A broken pipe makes the connection unusable even if the process still exists.
    try { this.child.kill(); }
    finally { this.onDisconnect(error); }
  }

  stop(): void { this.disconnect(new Error('Codex app-server stopped')); }
}
