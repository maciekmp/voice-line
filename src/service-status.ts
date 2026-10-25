import type { ApplicationCapabilities } from './application-contract.ts';

// Create one reporter per runtime so retries announce their own startup.
export function createReadinessReporter(write: (message: string) => void) {
  const previous = new Map<string, string>();
  return ({ capabilities }: { capabilities: ApplicationCapabilities }) => {
    const recordingReady = capabilities.text.state === 'ready' && capabilities.recording.state === 'ready';
    const statuses = {
      text: { key: capabilities.text.state, message: capabilities.text.state === 'starting' ? 'Uruchamiam rozmowę tekstową…'
        : capabilities.text.state === 'ready' ? 'Rozmowa tekstowa gotowa.' : undefined },
      recording: { key: `${capabilities.recording.state}:${recordingReady}`, message: recordingReady
        ? 'Nagrywanie gotowe — możesz przytrzymać Copilot.'
        : capabilities.recording.state === 'starting' ? 'Uruchamiam mikrofon i rozpoznawanie mowy…'
          : capabilities.recording.state === 'ready' && capabilities.text.state === 'starting'
            ? 'Mikrofon i rozpoznawanie gotowe — czekam na rozmowę tekstową…' : undefined },
      playback: { key: capabilities.playback.state, message: capabilities.playback.state === 'starting' ? 'Uruchamiam odczytywanie…'
        : capabilities.playback.state === 'ready' ? 'Odczytywanie gotowe.' : undefined },
    };
    for (const [name, { key, message }] of Object.entries(statuses)) {
      if (previous.get(name) !== key && message) write(message);
      previous.set(name, key);
    }
  };
}
