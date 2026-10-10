import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WhisperTranscriber } from '../src/stt/transcriber.ts';

const wav = process.argv[2] ? resolve(process.argv[2]) : '';
if (!wav || !existsSync(wav)) {
  console.error('Usage: npm run bench:stt -- "C:\\path\\to\\recording.wav"');
  process.exit(1);
}

const binary = process.env.WHISPER_BIN ?? 'whisper-cli.exe';
const model = process.env.WHISPER_MODEL ?? '';
const language = process.env.STT_LANGUAGE ?? 'pl';
if (!model) throw new Error('WHISPER_MODEL is required in .env');
process.env.STT_MODE = 'server';

for (const threads of [4, 8]) {
  process.env.WHISPER_THREADS = String(threads);
  const stt = new WhisperTranscriber(binary, model, language);
  try {
    const loadingStartedAt = performance.now();
    await stt.start();
    console.log(`\n${threads} threads: model loaded in ${((performance.now() - loadingStartedAt) / 1000).toFixed(2)} s`);
    for (let run = 1; run <= 2; run++) {
      const startedAt = performance.now();
      const text = await stt.transcribe(wav);
      console.log(`  run ${run}: ${((performance.now() - startedAt) / 1000).toFixed(2)} s | ${text}`);
    }
  } finally {
    stt.stop();
  }
}
