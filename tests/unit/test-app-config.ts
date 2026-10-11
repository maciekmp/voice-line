import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAppConfig, loadCodexConfig, loadWhisperConfig, loadPlaybackConfig, loadPiperConfig, loadRealtimeConfig } from '../../src/app-config.ts';
import { CodexAppServer } from '../../src/codex-app-server.ts';
import { CodexClient } from '../../src/codex.ts';
import { ConversationSession } from '../../src/conversation-session.ts';

test('configuration captures an immutable snapshot instead of retaining environment references', () => {
  const env = { WHISPER_MODEL: 'model', CODEX_MODEL: 'before', WHISPER_THREADS: '8', COPILOT_VK: '134',
    FFMPEG_BIN: 'capture-before', FFPLAY_BIN: 'play-before', OPENAI_API_KEY: 'test-placeholder',
    VOICE: 'Paulina', TTS_RATE: '3' };
  const config = loadAppConfig(env);
  env.CODEX_MODEL = 'after'; env.FFMPEG_BIN = 'capture-after'; env.WHISPER_THREADS = '2';
  assert.equal(config.codex.model, 'before');
  assert.equal(config.ffmpeg, 'capture-before');
  assert.equal(config.whisper.threads, 8);
  assert.equal(config.realtime.player, 'play-before');
  assert.equal(config.sapi.voice, 'Paulina');
  assert.equal(config.sapi.rate, 3);
  assert.ok(Object.isFrozen(config));
  for (const key of ['codex', 'whisper', 'piper', 'sapi', 'realtime'] as const) assert.ok(Object.isFrozen(config[key]));
  assert.throws(() => Object.assign(config.codex, { model: 'mutated' }), TypeError);
});

test('invalid backend names never silently select a default, including resource-free construction', () => {
  for (const [key, value] of [['VOICE_MODE', 'locla'], ['CODEX_MODE', 'clii'], ['STT_MODE', 'clii'], ['TTS_MODE', 'sap']] as const) {
    assert.throws(() => loadAppConfig({ WHISPER_MODEL: 'model', [key]: value }, false), new RegExp(key));
  }
  assert.equal(loadAppConfig({ CODEX_MODE: 'app-server', STT_MODE: 'server' }, false).voiceMode, 'local');
});

test('selected mode validates its own services and configuration errors identify the setting', () => {
  const config = loadAppConfig({ VOICE_MODE: 'realtime', STT_MODE: 'bad', WHISPER_THREADS: 'bad',
    TTS_MODE: 'bad', TTS_RATE: 'bad' });
  assert.equal(config.voiceMode, 'realtime');
  assert.throws(() => loadAppConfig({ VOICE_MODE: 'realtime', CODEX_MODE: 'cli' }), /requires the app-server/);
  assert.throws(() => loadAppConfig({}), /WHISPER_MODEL/);
  for (const [key, value] of [['WHISPER_THREADS', '0'], ['WHISPER_THREADS', '1.5'], ['COPILOT_VK', 'NaN'],
    ['COPILOT_VK', '256'], ['COPILOT_VK', ''], ['TTS_RATE', '11']] as const) {
    assert.throws(() => loadAppConfig({ WHISPER_MODEL: 'model', [key]: value }), new RegExp(key));
  }
});

test('Whisper server defaults follow the overridden executable, and explicit null threads stays null', () => {
  const binary = join(tmpdir(), 'whisper', 'whisper-cli.exe');
  const config = loadWhisperConfig({ WHISPER_THREADS: '8' }, { binary, model: 'model', language: 'pl', threads: null });
  assert.equal(config.serverBinary, join(tmpdir(), 'whisper', 'whisper-server.exe'));
  assert.equal(config.threads, null);
});

test('app-server requests keep model, image model and effort from the injected configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { CODEX_MODEL: 'text-before', CODEX_IMAGE_MODEL: 'image-before', CODEX_EFFORT: 'medium' };
  const config = loadCodexConfig(env), requests: any[] = [], threadRequests: any[] = [];
  class Server extends CodexAppServer {
    override async start() {}
    protected override async request(method: string, params: any): Promise<any> {
      if (method === 'thread/start' || method === 'thread/resume') {
        threadRequests.push(params);
        return { thread: { id: '11111111-1111-1111-1111-111111111111' } };
      }
      if (method === 'turn/start') {
        requests.push(params);
        (this as any).onMessage({ method: 'item/completed', params: { threadId: params.threadId,
          item: { type: 'agentMessage', text: JSON.stringify({ prompt: 'Q', answer: 'A' }) } } });
        (this as any).onMessage({ method: 'turn/completed', params: { threadId: params.threadId,
          turn: { id: 'turn', status: 'completed' } } });
        return { turn: { id: 'turn' } };
      }
      return {};
    }
  }
  const server = new Server(root, new ConversationSession(root), true, { config });
  env.CODEX_MODEL = 'text-after'; env.CODEX_EFFORT = 'high';
  await server.respond('Q');
  assert.equal(requests[0].model, 'text-before');
  assert.equal(requests[0].effort, 'medium');
  await server.respond('Second question');
  assert.ok(threadRequests.every(params => params.config.web_search === 'live'), 'New and resumed threads allow live search');
  assert.ok(requests.every(params => params.input[0].text.includes('wyszukiwania i przeglądania internetu')));
});

test('playback prefers native FFplay beside configured FFmpeg while preserving explicit overrides', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-player-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { FFMPEG_BIN: join(root, 'ffmpeg.exe') };
  assert.equal(loadPlaybackConfig(env).ffplay, 'ffplay.exe');
  const player = join(root, 'ffplay.exe');
  await writeFile(player, 'native-player-fixture');
  assert.equal(loadPlaybackConfig(env).ffplay, player);
  assert.equal(loadPiperConfig(env).player, player);
  assert.equal(loadRealtimeConfig(env).player, player);
  assert.equal(loadPlaybackConfig({ ...env, FFPLAY_BIN: 'explicit-player' }).ffplay, 'explicit-player');
  assert.equal(loadPlaybackConfig({ FFMPEG_BIN: 'ffmpeg.exe' }).ffplay, 'ffplay.exe');
});

test('CLI uses the injected model across successive answers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'voice-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadCodexConfig({ CODEX_MODEL: 'configured-model' });
  const client = new CodexClient(root, 'codex.cmd', undefined, config), args: string[][] = [];
  Object.assign(client, { start: async () => {}, historyServer: { readLatestExchange: async () => ({ question: 'Q', answer: 'A' }) }, run: async (input: string[]) => {
    args.push(input); return { text: JSON.stringify({ prompt: 'Q', answer: 'A' }), threadId: '11111111-1111-1111-1111-111111111111' };
  } });
  await client.respond('first'); await client.respond('second');
  assert.ok(args.every(input => input[input.indexOf('-m') + 1] === 'configured-model'));
  assert.ok(args.every(input => input.includes('web_search="live"')), 'CLI enables live search on new and resumed turns');
});
