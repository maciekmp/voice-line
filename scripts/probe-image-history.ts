// Read-only cross-auth history check using an already generated image. No inference.
import { readFile, mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexAppServer } from '../src/codex-app-server.ts';
import { CodexRealtime } from '../src/codex-realtime.ts';
import { ConversationSession, type ConversationExchange } from '../src/conversation-session.ts';
import { appendImageLink, type ImageTask } from '../src/image-artifacts.ts';

const cwd = resolve('.chatgpt-button', 'image-history-probe');
await mkdir(cwd, { recursive: true });
// The probe owns this isolated session; each run checks a fresh voice thread.
await unlink(resolve(cwd, '.chatgpt-button-realtime-session.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
const source = JSON.parse(await readFile(resolve('.chatgpt-button/imagegen-probe/chatgpt/.chatgpt-button-session.json'), 'utf8'));
class Source extends CodexAppServer {
  rpc(method: string, params: object) { return this.request(method, params); }
}
class Voice extends CodexRealtime {
  protected override async request(method: string, params: object): Promise<any> {
    try { return await super.request(method, params); }
    catch (error) { throw new Error(`${method}: ${error instanceof Error ? error.message : error}`); }
  }
  history() { return this.readHistory(this.currentThreadId!); }
  async persistImage(exchange: ConversationExchange) {
    await this.request('thread/inject_items', { threadId: this.currentThreadId!, items: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ prompt: exchange.question, answer: exchange.answer }) }] }] });
  }
  remember(exchange: ConversationExchange, imageTask: ImageTask) {
    this.session.answered({ prompt: exchange.question, answer: exchange.answer, images: exchange.images, imageTask });
  }
}
const sourceClient = new Source(cwd, new ConversationSession(cwd, Date.now, 'source-session.json'), true);
const voice = new Voice(cwd);
let restored: Voice | undefined;
try {
  await sourceClient.start();
  const metadata = await sourceClient.rpc('thread/read', { threadId: source.threadId, includeTurns: false });
  const turns = metadata.thread.historyMode === 'paginated'
    ? (await sourceClient.rpc('thread/turns/list', { threadId: source.threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded' })).data
    : (await sourceClient.rpc('thread/read', { threadId: source.threadId, includeTurns: true })).thread.turns.slice().reverse();
  const turn = turns.find((turn: any) => turn.status === 'completed');
  if (!turn) throw new Error('No completed source image turn');
  const exchange = (await sourceClient.readImageTurn(source.threadId, turn.id)).find(exchange => exchange.images?.length);
  if (!exchange) throw new Error('Source turn has no generated image');
  await voice.start();
  console.log('Fresh API thread started');
  const task = { threadId: source.threadId, turnId: turn.id };
  await voice.persistImage(exchange);
  await appendImageLink(cwd, voice.currentThreadId!, { ...task, anchor: 0 });
  voice.remember(exchange, task);
  const imageId = exchange.images![0].id;
  voice.stop();
  restored = new Voice(cwd);
  console.log('Restoring API thread');
  await restored.start();
  if (restored.currentExchanges.at(-1)?.images?.[0]?.id !== imageId) throw new Error('Cross-auth image history did not restore');
  console.log('API voice + ChatGPT image history after restart: passed (no inference)');
} finally { sourceClient.stop(); voice.stop(); restored?.stop(); }
