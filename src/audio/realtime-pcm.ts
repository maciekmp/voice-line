/** Recorder WAV -> mono PCM16 at the Realtime API's 24 kHz rate. */
export function realtimePcm(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid microphone WAV');
  }
  let format: Buffer | undefined, pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > wav.length) throw new Error('Truncated microphone WAV');
    const id = wav.toString('ascii', offset, offset + 4);
    if (id === 'fmt ') format = wav.subarray(offset + 8, end);
    if (id === 'data') pcm = wav.subarray(offset + 8, end);
    offset = end + (size % 2);
  }
  if (!format || format.length < 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
    || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16 || !pcm?.length || pcm.length % 2) {
    throw new Error('Realtime input requires a 16 kHz mono PCM16 recording');
  }
  const count = pcm.length / 2;
  if (count > 16000 * 60) throw new Error('Realtime recordings are limited to 60 seconds');
  const output = Buffer.alloc(Math.ceil(count * 1.5) * 2);
  for (let i = 0; i < output.length / 2; i++) {
    const position = i * 2 / 3;
    const left = Math.min(count - 1, Math.floor(position));
    const right = Math.min(count - 1, left + 1);
    const fraction = position - left;
    output.writeInt16LE(Math.round(pcm.readInt16LE(left * 2) * (1 - fraction) + pcm.readInt16LE(right * 2) * fraction), i * 2);
  }
  return output;
}

export type RealtimeAudioChunk = {
  data: string; sampleRate: number; numChannels: number;
  samplesPerChannel: number | null; itemId: string | null;
};

export function decodeRealtimeAudio(audio: RealtimeAudioChunk): Buffer {
  if (!audio || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 96000
    || ![1, 2].includes(audio.numChannels) || typeof audio.data !== 'string'
    || audio.data.length > 8 * 1024 * 1024 || audio.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) {
    throw new Error('Invalid realtime audio chunk');
  }
  const pcm = Buffer.from(audio.data, 'base64');
  if (pcm.toString('base64') !== audio.data) throw new Error('Invalid realtime audio encoding');
  if (pcm.length % (2 * audio.numChannels) || (audio.samplesPerChannel != null
    && audio.samplesPerChannel !== pcm.length / (2 * audio.numChannels))) throw new Error('Invalid realtime PCM sample count');
  return pcm;
}
