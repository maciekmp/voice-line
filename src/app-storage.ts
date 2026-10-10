import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ConversationSession } from './conversation-session.ts';
import type { LocalHistoryResult } from './conversation-session.ts';
import { ConversationRetention } from './conversation-retention.ts';

const { appDataDirectory } = createRequire(import.meta.url)('../electron/app-data.cjs') as {
  appDataDirectory: (env?: NodeJS.ProcessEnv) => string;
};
export { appDataDirectory };
export type AppStorage = {
  ephemeral: boolean;
  home: string;
  dataDirectory: string;
  session: ConversationSession;
  retention: ConversationRetention;
  historyLoadResults: LocalHistoryResult[];
  prepare: () => Promise<void>;
};

export function createAppStorage(mode: 'local' | 'realtime' | 'imagegen', directory = appDataDirectory()): AppStorage {
  const home = join(directory, `${mode}-codex`);
  const ephemeral = mode !== 'realtime';
  const session = new ConversationSession(home, Date.now, 'session.json', { durablePrevious: true, localHistory: ephemeral });
  const historyLoadResults = session.loadLocalHistory();
  return { ephemeral, home, dataDirectory: directory, session, historyLoadResults, retention: new ConversationRetention(home, directory),
    prepare: async () => {
      await mkdir(home, { recursive: true });
    },
  };
}
