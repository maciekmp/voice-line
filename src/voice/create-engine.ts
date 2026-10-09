import { CodexClient } from '../codex.ts';
import { CodexAppServer } from '../codex-app-server.ts';
import { CodexRealtime } from '../codex-realtime.ts';
import { WhisperTranscriber } from '../stt/transcriber.ts';
import { Speaker } from '../speaker.ts';
import { PiperSpeaker } from '../piper-speaker.ts';
import { LocalVoiceEngine } from './local-engine.ts';
import { RealtimeVoiceEngine } from './realtime-engine.ts';
import type { VoiceEngine } from '../voice-engine.ts';

export function createVoiceEngine(cwd: string, validate = true): VoiceEngine {
  const mode = process.env.VOICE_MODE ?? 'local';
  const tts = process.env.TTS_MODE ?? 'sapi';
  if (validate && !['local', 'realtime'].includes(mode)) throw new Error('VOICE_MODE must be local or realtime.');
  if (mode === 'realtime') {
    if (validate && process.env.CODEX_MODE === 'cli') throw new Error('VOICE_MODE=realtime requires the app-server backend. Remove CODEX_MODE=cli.');
    return new RealtimeVoiceEngine(new CodexRealtime(cwd));
  }
  if (validate && !['sapi', 'piper'].includes(tts)) throw new Error('TTS_MODE must be sapi or piper.');
  const model = process.env.WHISPER_MODEL ?? '';
  if (validate && !model) throw new Error('Set WHISPER_MODEL for VOICE_MODE=local.');
  const client = process.env.CODEX_MODE === 'cli' ? new CodexClient(cwd) : new CodexAppServer(cwd);
  return new LocalVoiceEngine(client, new WhisperTranscriber(process.env.WHISPER_BIN ?? 'whisper-cli.exe', model,
    process.env.STT_LANGUAGE ?? 'pl'), tts === 'piper' ? new PiperSpeaker() : new Speaker(), tts);
}
