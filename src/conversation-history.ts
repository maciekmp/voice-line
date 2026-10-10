import type { ConversationExchange } from './conversation-session.ts';
import { storeGeneratedImage } from './image-artifacts.ts';

type Request = (method: string, params: object) => Promise<any>;

async function pages(request: Request, method: string, params: object): Promise<any[]> {
  const data: any[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await request(method, { ...params, ...(cursor && { cursor }) });
    if (!Array.isArray(page?.data)) throw new Error('Codex returned invalid conversation history');
    data.push(...page.data);
    if (page.nextCursor == null) break;
    if (typeof page.nextCursor !== 'string' || !page.nextCursor || cursors.has(page.nextCursor)) {
      throw new Error('Codex returned an invalid history cursor');
    }
    cursor = page.nextCursor;
    cursors.add(page.nextCursor);
  } while (true);
  return data;
}

export async function readConversationHistory(request: Request, threadId: string, cwd?: string, onlyTurnId?: string, dataDirectory?: string): Promise<ConversationExchange[]> {
  const metadata = await request('thread/read', { threadId, includeTurns: false });
  if (metadata?.thread?.id !== threadId) throw new Error('Codex returned a different conversation');
  let turns: any[];
  if (metadata.thread.historyMode === 'paginated') {
    turns = await pages(request, 'thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'notLoaded' });
    const items = await pages(request, 'thread/items/list', { threadId, limit: 100, sortDirection: 'asc' });
    const byTurn = new Map<string, any[]>();
    for (const entry of items) {
      const list = byTurn.get(entry.turnId) || [];
      list.push(entry.item);
      byTurn.set(entry.turnId, list);
    }
    turns = turns.map(turn => ({ ...turn, items: byTurn.get(turn.id) || [] }));
  } else {
    const history = await request('thread/read', { threadId, includeTurns: true });
    if (history?.thread?.id !== threadId || !Array.isArray(history.thread.turns)) {
      throw new Error('Codex returned invalid conversation history');
    }
    turns = history.thread.turns;
  }
  return exchangesFromTurns(turns, cwd, onlyTurnId, dataDirectory);
}

export async function readLatestConversationExchange(request: Request, threadId: string, cwd: string, dataDirectory?: string): Promise<ConversationExchange | undefined> {
  const metadata = await request('thread/read', { threadId, includeTurns: false });
  if (metadata?.thread?.id !== threadId) throw new Error('Codex returned a different conversation');
  let turn: any;
  if (metadata.thread.historyMode === 'paginated') {
    const page = await request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
    if (!Array.isArray(page?.data)) throw new Error('Codex returned invalid latest turn');
    turn = page.data[0];
    if (turn) turn = { ...turn, items: (await pages(request, 'thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc' })).map(entry => entry.item) };
  } else {
    const history = await request('thread/read', { threadId, includeTurns: true });
    if (history?.thread?.id !== threadId || !Array.isArray(history.thread.turns)) throw new Error('Codex returned invalid conversation history');
    turn = history.thread.turns.at(-1);
  }
  return (await exchangesFromTurns(turn ? [turn] : [], cwd, undefined, dataDirectory))[0];
}

async function exchangesFromTurns(turns: any[], cwd?: string, onlyTurnId?: string, dataDirectory?: string): Promise<ConversationExchange[]> {
  const exchanges: ConversationExchange[] = [];
  for (const turn of turns) {
    if (turn.status !== 'completed' || !Array.isArray(turn.items) || (onlyTurnId && turn.id !== onlyTurnId)) continue;
    const images = cwd ? await Promise.all(turn.items.filter((item: any) => item.type === 'imageGeneration' && item.status === 'completed')
      .map((item: any) => storeGeneratedImage(cwd, item, dataDirectory))) : [];
    for (const item of [...turn.items].reverse()) {
      if (item?.type !== 'agentMessage' || item.phase === 'commentary' || typeof item.text !== 'string') continue;
      try {
        const reply = JSON.parse(item.text);
        if (typeof reply?.prompt === 'string' && typeof reply.answer === 'string' && reply.answer.trim()) {
          exchanges.push({ question: reply.prompt, answer: reply.answer, ...(images.length && { images }) });
          break;
        }
      } catch { /* Non-answer items are not part of the voice conversation. */ }
    }
  }
  return exchanges;
}
