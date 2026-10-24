import { dirname, isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const { appDataDirectory } = createRequire(import.meta.url)('./app-data.cjs') as { appDataDirectory: (env?: NodeJS.ProcessEnv) => string };

export type CodexConfig = Readonly<{ mode: 'app-server' | 'cli'; model?: string; imageModel: string; effort: string }>;
export type WhisperConfig = Readonly<{ binary: string; serverBinary: string; model: string; language: string; mode: 'server' | 'cli'; threads: number | null }>;
export type PlaybackConfig = Readonly<{ ffplay: string }>;
export type PiperConfig = Readonly<{ binary: string; model: string; player: string }>;
export type SapiConfig = Readonly<{ voice?: string; rate: number }>;
export type RealtimeConfig = Readonly<{ apiKey: string; voice?: string; model?: string; player: string }>;
export type AppConfig = Readonly<{
  voiceMode: 'local' | 'realtime'; ttsMode: 'sapi' | 'piper'; dataDirectory: string;
  microphone: string; copilotVk: number; saveAudio: boolean; ffmpeg: string;
  codex: CodexConfig; whisper: WhisperConfig; piper: PiperConfig; sapi: SapiConfig; realtime: RealtimeConfig;
  serviceErrors?: Readonly<{ recording?: string; playback?: string; shortcut?: string }>;
}>;

function choice<T extends string>(env: NodeJS.ProcessEnv, key: string, values: readonly T[], fallback: T): T {
  const value = env[key] ?? fallback;
  if (!values.includes(value as T)) throw new Error(`${key} must be ${values.join(' or ')}.`);
  return value as T;
}
function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < min || value > max || env[key]?.trim() === '') throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}
const optional = (value: string | undefined) => value?.trim() || undefined;

export function loadCodexConfig(env: NodeJS.ProcessEnv = process.env): CodexConfig {
  return Object.freeze({ mode: choice(env, 'CODEX_MODE', ['app-server', 'cli'], 'app-server'),
    model: optional(env.CODEX_MODEL), imageModel: optional(env.CODEX_IMAGE_MODEL) ?? 'gpt-6.1-sol', effort: env.CODEX_EFFORT ?? 'low' });
}
export function loadWhisperConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<WhisperConfig> = {}): WhisperConfig {
  const binary = overrides.binary ?? env.WHISPER_BIN ?? 'whisper-cli.exe';
  return Object.freeze({ binary, model: overrides.model ?? env.WHISPER_MODEL ?? '', language: overrides.language ?? env.STT_LANGUAGE ?? 'pl',
    serverBinary: overrides.serverBinary ?? env.WHISPER_SERVER_BIN ?? (isAbsolute(binary) ? join(dirname(binary), 'whisper-server.exe') : 'whisper-server.exe'),
    mode: overrides.mode ?? choice<'server' | 'cli'>(env, 'STT_MODE', ['server', 'cli'], 'server'),
    threads: overrides.threads !== undefined ? overrides.threads : (env.WHISPER_THREADS === undefined ? null : integer(env, 'WHISPER_THREADS', 4, 1, 1024)) });
}
export function loadPlaybackConfig(env: NodeJS.ProcessEnv = process.env): PlaybackConfig {
  // Chocolatey's PATH entry is a launcher: killing it can leave FFplay playing.
  // Prefer the real player beside a configured native FFmpeg executable.
  const sibling = env.FFMPEG_BIN && isAbsolute(env.FFMPEG_BIN) ? join(dirname(env.FFMPEG_BIN), 'ffplay.exe') : undefined;
  return Object.freeze({ ffplay: env.FFPLAY_BIN ?? (sibling && existsSync(sibling) ? sibling : 'ffplay.exe') });
}
export function loadPiperConfig(env: NodeJS.ProcessEnv = process.env): PiperConfig {
  return Object.freeze({ binary: env.PIPER_BIN ?? 'piper.exe', model: env.PIPER_MODEL ?? '', player: loadPlaybackConfig(env).ffplay });
}
export function loadSapiConfig(env: NodeJS.ProcessEnv = process.env): SapiConfig {
  return Object.freeze({ voice: optional(env.VOICE), rate: integer(env, 'TTS_RATE', 2, -10, 10) });
}
export function loadRealtimeConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  return Object.freeze({ apiKey: optional(env.OPENAI_API_KEY) ?? '', voice: optional(env.CODEX_REALTIME_VOICE),
    model: optional(env.CODEX_REALTIME_MODEL), player: loadPlaybackConfig(env).ffplay });
}
export function loadRecorderConfig(env: NodeJS.ProcessEnv = process.env): Readonly<{ ffmpeg: string }> {
  return Object.freeze({ ffmpeg: env.FFMPEG_BIN ?? 'ffmpeg.exe' });
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env, validateResources = true, isolateAudioErrors = false): AppConfig {
  const serviceErrors: { recording?: string; playback?: string; shortcut?: string } = {};
  function audio<T>(service: keyof typeof serviceErrors, load: () => T, fallback: () => T): T {
    try { return load(); }
    catch (error) {
      if (!isolateAudioErrors) throw error;
      serviceErrors[service] = error instanceof Error ? error.message : String(error);
      return fallback();
    }
  }
  const voiceMode = choice(env, 'VOICE_MODE', ['local', 'realtime'], 'local');
  const codex = loadCodexConfig(env);
  if (voiceMode === 'realtime' && codex.mode === 'cli') throw new Error('VOICE_MODE=realtime requires the app-server backend. Remove CODEX_MODE=cli.');
  const ttsMode = voiceMode === 'local' ? audio<'sapi' | 'piper'>('playback', () => choice(env, 'TTS_MODE', ['sapi', 'piper'], 'sapi'), () => 'sapi') : 'sapi';
  const whisper = audio('recording', () => loadWhisperConfig(voiceMode === 'local' ? env : {}), () => loadWhisperConfig({}));
  if (validateResources && voiceMode === 'local' && !whisper.model) throw new Error('Set WHISPER_MODEL for VOICE_MODE=local.');
  return Object.freeze({ voiceMode, ttsMode, dataDirectory: appDataDirectory(env),
    microphone: env.MIC_DEVICE ?? '', copilotVk: audio('shortcut', () => integer(env, 'COPILOT_VK', 134, 1, 255), () => 134), saveAudio: env.SAVE_AUDIO === '1',
    ffmpeg: loadRecorderConfig(env).ffmpeg, codex, whisper, piper: loadPiperConfig(env),
    sapi: audio('playback', () => loadSapiConfig(voiceMode === 'local' && ttsMode === 'sapi' ? env : {}), () => loadSapiConfig({})), realtime: loadRealtimeConfig(env),
    ...(isolateAudioErrors && { serviceErrors: Object.freeze(serviceErrors) }) });
}
