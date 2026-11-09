import { createRequire } from 'node:module';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ConversationSession } from './conversation-session.ts';
import type { LocalHistoryResult } from './conversation-session.ts';
import { ConversationRetention } from './conversation-retention.ts';
import { ArtifactStore, type ImageLink } from './artifact-store.ts';
import { ConversationRepository } from './conversation-repository.ts';
import { ConversationService } from './conversation-service.ts';
import type { VoiceReply, ConversationExchange, ConversationCheckpoint } from './conversation-contract.ts';

const { appDataDirectory } = createRequire(import.meta.url)('./app-data.cjs') as {
  appDataDirectory: (env?: NodeJS.ProcessEnv) => string;
};
export { appDataDirectory };
export type AppStorage = {
  ephemeral: boolean;
  home: string;
  dataDirectory: string;
  session: ConversationSession;
  retention: ConversationRetention;
  artifacts: ArtifactStore;
  historyLoadResults: LocalHistoryResult[];
  conversation: ConversationService;
  prepare: () => Promise<void>;
  commitReply: (reply: VoiceReply, link?: ImageLink, canCommit?: () => boolean) => Promise<void>;
  interruptTurn: (checkpoint: ConversationCheckpoint, partial?: VoiceReply) => void;
  importHistory: (id: string, exchanges: ConversationExchange[]) => Promise<ConversationExchange[]>;
  restorePrevious: (canCommit?: () => boolean) => Promise<boolean>;
};

export function createAppStorage(mode: 'local' | 'realtime' | 'imagegen', directory = appDataDirectory()): AppStorage {
  const home = join(directory, `${mode}-codex`);
  const ephemeral = mode !== 'realtime';
  const repository = new ConversationRepository(join(home, 'session.json'), undefined, directory, { versioned: true });
  const session = new ConversationSession(home, Date.now, 'session.json', { durablePrevious: true, localHistory: true, allowMissingHistory: !ephemeral, repository });
  const historyLoadResults = session.loadLocalHistory();
  let conversation!: ConversationService;
  const storage: AppStorage = { ephemeral, home, dataDirectory: directory, session, historyLoadResults,
    retention: new ConversationRetention(home, directory), artifacts: new ArtifactStore(directory),
    get conversation() { return conversation; },
    commitReply: (reply, link, canCommit) => conversation.commitExchange(reply, link, canCommit),
    interruptTurn: (checkpoint, partial) => conversation.interruptTurn(checkpoint, partial),
    importHistory: (id, exchanges) => conversation.importHistory(id, exchanges),
    restorePrevious: canCommit => conversation.restorePrevious(canCommit),
    prepare: async () => {
      await mkdir(home, { recursive: true });
    },
  };
  conversation = new ConversationService(storage);
  return storage;
}
