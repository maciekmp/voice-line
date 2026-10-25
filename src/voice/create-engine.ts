import { CodexClient } from '../codex.ts';
import { CodexAppServer } from '../codex-app-server.ts';
import { CodexRealtime } from '../codex-realtime.ts';
import { WhisperTranscriber } from '../stt/transcriber.ts';
import { Speaker } from '../speaker.ts';
import { PiperSpeaker } from '../piper-speaker.ts';
import { LocalVoiceEngine } from './local-engine.ts';
import { RealtimeVoiceEngine } from './realtime-engine.ts';
import type { VoiceEngine } from '../voice-engine.ts';
import { createAppStorage } from '../app-storage.ts';
import { loadAppConfig, type AppConfig } from '../app-config.ts';
import type { CodexRawLog } from '../codex-rpc-transport.ts';

export function createVoiceEngine(cwd: string, validate = true, config: AppConfig = loadAppConfig(undefined, validate), rawLog?: CodexRawLog): VoiceEngine {
  const mode = config.voiceMode;
  const tts = config.ttsMode;
  if (mode === 'realtime') {
    return new RealtimeVoiceEngine(new CodexRealtime(cwd, createAppStorage('realtime', config.dataDirectory), createAppStorage('imagegen', config.dataDirectory), config, rawLog));
  }
  const model = config.whisper.model;
  if (validate && !model) throw new Error('Set WHISPER_MODEL for VOICE_MODE=local.');
  const storage = createAppStorage('local', config.dataDirectory);
  const client = config.codex.mode === 'cli' ? new CodexClient(cwd, 'codex.cmd', storage, config.codex, rawLog)
    : new CodexAppServer(cwd, storage.session, false, { storage, config: config.codex, rawLog });
  return new LocalVoiceEngine(client, new WhisperTranscriber(config.whisper.binary, model,
    config.whisper.language, config.whisper), tts === 'piper'
      ? new PiperSpeaker(undefined, undefined, undefined, config.piper) : new Speaker(undefined, config.sapi), tts, config.serviceErrors);
}
