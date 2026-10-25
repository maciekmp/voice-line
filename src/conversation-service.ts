import type { ConversationSession } from './conversation-session.ts';
import type { ConversationRetention } from './conversation-retention.ts';
import type { ArtifactStore, ImageLink } from './artifact-store.ts';
import type { ConversationExchange, ConversationCheckpoint, VoiceReply } from './conversation-contract.ts';
import { codexThreadId, type CodexThreadId } from './conversation-identifiers.ts';
import { storageCoordinator } from './storage-coordinator.ts';

type Storage = { session: ConversationSession; retention: ConversationRetention; artifacts: ArtifactStore; dataDirectory: string; ephemeral: boolean };

// The provider supplies results and remote deletion; this service owns their durable effects.
export class ConversationService {
  private readonly storage: Storage;
  private readonly coordinator: ReturnType<typeof storageCoordinator>;
  constructor(storage: Storage) { this.storage = storage; this.coordinator = storageCoordinator(storage.dataDirectory); }
  interruptTurn(checkpoint: ConversationCheckpoint, partial?: VoiceReply): void {
    const { session } = this.storage;
    if (!session.threadId) return;
    const received = partial && (session.currentExchanges[checkpoint.exchanges.length] ?? partial);
    const references = [...checkpoint.exchanges, ...(received ? [received] : [])];
    const prepared = this.storage.retention.prepareTouch(session.threadId,
      references.flatMap(exchange => [...(exchange.images ?? []), ...(exchange.inputImages ?? [])]),
      references.flatMap(exchange => exchange.imageTask ? [exchange.imageTask] : []),
      this.storage.ephemeral ? undefined : session.codexThreadId ?? undefined);
    try { session.interruptTurn(checkpoint, partial, [{ file: prepared.file, contents: prepared.contents }]); }
    finally { prepared.release(); }
  }
  commitExchange(reply: VoiceReply, link?: ImageLink, canCommit?: () => boolean): Promise<void> {
    const { session } = this.storage, operation = session.captureOperation();
    return this.coordinator.exclusive(() => {
      if (!session.matchesOperation(operation) && !(session.threadId === operation.id && session.hasCommittedReply(reply))) throw new Error('Conversation changed before commit');
      if (canCommit && !canCommit()) throw new Error('Cancelled');
      if (!session.threadId) throw new Error('Conversation is unavailable');
      const prepared = this.storage.retention.prepareTouch(session.threadId, [...(reply.images ?? []), ...(reply.inputImages ?? [])], reply.imageTask,
        this.storage.ephemeral ? undefined : session.codexThreadId ?? undefined);
      try {
        const imageLink = link && this.storage.artifacts.prepareLink(session.threadId, link);
        session.answered(reply, [{ file: prepared.file, contents: prepared.contents }, ...(imageLink ? [imageLink] : [])]);
      } finally { prepared.release(); }
    });
  }
  importHistory(id: string, exchanges: ConversationExchange[]): Promise<ConversationExchange[]> {
    const { session } = this.storage, operation = session.captureOperation();
    return this.coordinator.exclusive(() => {
      if (!session.matchesOperation(operation)) throw new Error('Conversation changed before history import');
      const existing = session.readLocalHistoryResult(id);
      if (existing.status === 'loaded') return existing.exchanges;
      if (existing.status === 'corrupt') throw existing.error;
      const prepared = this.storage.retention.prepareTouch(id, exchanges.flatMap(exchange => [...(exchange.images ?? []), ...(exchange.inputImages ?? [])]),
        exchanges.flatMap(exchange => exchange.imageTask ? [exchange.imageTask] : []), this.storage.ephemeral ? undefined : session.providerThreadFor(id));
      try { session.cacheHistory(id, exchanges, [{ file: prepared.file, contents: prepared.contents }]); }
      finally { prepared.release(); }
      return session.readLocalHistory(id);
    });
  }
  restorePrevious(canCommit?: () => boolean): Promise<boolean> {
    const { session } = this.storage, operation = session.captureOperation();
    return this.coordinator.exclusive(() => {
      if (!session.matchesOperation(operation)) throw new Error('Conversation changed before restore');
      if (canCommit && !canCommit()) return false;
      const id = session.previousConversationId;
      if (!id || !session.canRestorePrevious) return false;
      const history = session.readLocalHistory(id);
      const prepared = this.storage.retention.prepareTouch(id, history.flatMap(exchange => [...(exchange.images ?? []), ...(exchange.inputImages ?? [])]),
        history.flatMap(exchange => exchange.imageTask ? [exchange.imageTask] : []), this.storage.ephemeral ? undefined : session.providerThreadFor(id));
      try { return session.restorePrevious([{ file: prepared.file, contents: prepared.contents }]); }
      finally { prepared.release(); }
    });
  }
  async prune(deleteRemote: (id: CodexThreadId) => Promise<void>): Promise<boolean> {
    const { session, retention, ephemeral } = this.storage;
    const removed = await retention.prune(async id => {
      if (!ephemeral) {
        for (const retired of retention.retiredProviderThreadsFor(id)) await deleteRemote(codexThreadId(retired));
        await deleteRemote(codexThreadId(retention.providerThreadFor(id) ?? session.providerThreadFor(id)));
      }
    });
    if (removed.length) await this.coordinator.exclusive(() => session.forget(removed));
    return removed.length > 0;
  }
}
