import { resolve } from 'node:path';

export class StorageBusyError extends Error {
  constructor() { super('Conversation storage is being deleted; retry after cleanup'); this.name = 'StorageBusyError'; }
}

// Shared by every storage/ArtifactStore instance in the application's single writer process.
class StorageCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, number>();
  private readonly deleting = new Set<string>();
  private deletingImages = false;

  exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const task = this.tail.then(work);
    this.tail = task.then(() => {}, () => {});
    return task;
  }
  lease(key: string): () => void {
    if (this.deleting.has(key) || this.deletingImages) throw new StorageBusyError();
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = this.active.get(key)! - 1;
      if (count) this.active.set(key, count); else this.active.delete(key);
    };
  }
  claimDelete(key: string): (() => void) | null {
    if (this.active.has(key) || this.deleting.has(key)) return null;
    this.deleting.add(key);
    return () => { this.deleting.delete(key); };
  }
  claimImages(): (() => void) | null {
    if (this.active.size || this.deletingImages) return null;
    this.deletingImages = true;
    return () => { this.deletingImages = false; };
  }
}

const coordinators = new Map<string, StorageCoordinator>();
export function storageCoordinator(root: string): StorageCoordinator {
  const path = resolve(root);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  let coordinator = coordinators.get(key);
  if (!coordinator) { coordinator = new StorageCoordinator(); coordinators.set(key, coordinator); }
  return coordinator;
}
export function conversationStorageKey(home: string, id: string): string {
  const path = resolve(home);
  return `${process.platform === 'win32' ? path.toLowerCase() : path}/${id.toLowerCase()}`;
}
