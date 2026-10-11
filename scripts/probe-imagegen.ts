// Explicit integration probe. No inference unless --generate is provided.
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { CodexAppServer } from '../src/codex-app-server.ts';
import { ConversationSession } from '../src/conversation-session.ts';
import { CodexClient, type VoiceReply } from '../src/codex.ts';

const directory = resolve('.app-data', 'imagegen-probe', process.argv.includes('--api') ? 'api' : process.argv.includes('--cli') ? 'cli' : 'chatgpt');
await mkdir(directory, { recursive: true });
class Probe extends CodexAppServer {
  onEvent?: (method: string, params: any) => void;
  constructor() {
    const api = process.argv.includes('--api');
    if (api && !process.env.OPENAI_API_KEY?.trim()) throw new Error('--api requires OPENAI_API_KEY');
    super(directory, new ConversationSession(directory), true, api
      ? { home: resolve(directory, 'api-home'), apiKey: process.env.OPENAI_API_KEY!.trim() } : {});
  }
  rpc(method: string, params: object = {}) { return this.request(method, params); }
  protected override onNotification(method: string, params: any) { this.onEvent?.(method, params); }
}
const client = new Probe();
try {
  await client.start();
  const account = await client.rpc('account/read');
  console.log('Authentication:', account.account?.type ?? 'none');
  console.log('Provider capabilities:', JSON.stringify(await client.rpc('modelProvider/capabilities/read')));
  const models = await client.rpc('model/list');
  console.log('Models:', JSON.stringify(models.data?.map((model: any) => ({ id: model.id, model: model.model, isDefault: model.isDefault }))));
  if (process.argv.includes('--inject')) {
    const thread = await client.rpc('thread/start', { cwd: directory, sandbox: 'read-only', approvalPolicy: 'never' });
    await client.rpc('thread/inject_items', { threadId: thread.thread.id, items: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: JSON.stringify({ prompt: 'Image request', answer: 'Image generated',
        images: [{ id: 'a'.repeat(64), alt: 'Test image' }] }) }] }] });
    const history = await client.rpc('thread/timeline/list', { threadId: thread.thread.id, limit: 100 });
    console.log('Injected history:', JSON.stringify(history.data));
  }
  if (process.argv.includes('--integrated') || process.argv.includes('--automatic')) {
    client.onEvent = (method, params) => {
      if (method === 'item/completed' && params.item?.type === 'agentMessage') console.log('Assistant:', params.item.text);
      if (method === 'item/completed' && params.item?.type === 'imageGeneration') console.log('Image status:', params.item.status);
    };
    const responder = process.argv.includes('--cli') ? new CodexClient(directory) : client;
    let reply: VoiceReply;
    try {
      reply = process.argv.includes('--automatic')
        ? await responder.respond('Chciałbym ilustrację przedstawiającą prosty niebieski kwadrat na białym tle. Stwórz ją dla mnie.')
        : await responder.generateImage('Prosty czerwony kwadrat pośrodku białego tła. Jeden obraz.');
    } finally { if (responder !== client) responder.stop(); }
    console.log('Production image task:', JSON.stringify(reply));
    if (!reply.images?.length) throw new Error('Missing generated image');
    client.stop();
    const restored = new Probe();
    try {
      await restored.start();
      if (restored.currentExchanges.at(-1)?.images?.[0]?.id !== reply.images[0].id) throw new Error('Image history was not restored');
      console.log('Image history after restart: passed');
    } finally { restored.stop(); }
  }
  if (process.argv.includes('--generate')) {
    const thread = await client.rpc('thread/start', { cwd: directory, model: 'gpt-6.1-sol', sandbox: 'read-only', approvalPolicy: 'never' });
    const threadId = thread.thread.id;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const timer = setTimeout(finish, 240_000);
    let completed = false;
    client.onEvent = (method, params) => {
      if (params?.threadId !== threadId) return;
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item;
        if (item?.type === 'imageGeneration') console.log('Image:', JSON.stringify({ event: method, id: item.id,
          status: item.status, savedPath: item.savedPath, resultLength: item.result?.length, failure: item.failure }));
        else if (item?.type === 'agentMessage' && method === 'item/completed') console.log('Assistant:', item.text);
        else console.log('Item:', method, item?.type);
      }
      if (method === 'turn/completed') { completed = true; console.log('Turn status:', params.turn.status); finish(); }
    };
    try {
      await client.rpc('turn/start', { threadId, model: 'gpt-6.1-sol', approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' }, input: [{ type: 'text', text:
          'Generate exactly one simple image: a solid blue circle centered on a white background. Use only the built-in image generation tool. Do not run commands, read files, call MCP tools or modify project files. Return a very short confirmation.' }] });
      await done;
      if (!completed) throw new Error('Image generation probe timed out');
    } finally { clearTimeout(timer); }
  }
} finally { client.stop(); }
