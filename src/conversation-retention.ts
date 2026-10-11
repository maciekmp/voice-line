import { readFileSync } from 'node:fs';
import { unlink, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { GeneratedImage, ImageTask } from './conversation-contract.ts';
import { storageCoordinator, conversationStorageKey } from './storage-coordinator.ts';
const { writeAtomicSync } = createRequire(import.meta.url)('./atomic-file.cjs') as { writeAtomicSync: (file: string, contents: string) => void };

export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
type Record = { updatedAt: number; images: string[]; tasks?: string[]; deleted?: boolean; revision?: number; providerThreadId?: string; retiredProviderThreads?: string[] };
type Index = { [threadId: string]: Record };
export type CleanupHealth = { state: 'healthy' | 'deferred'; issues: { file: string; error: Error }[]; reason?: 'active-conversation' };
const validId = /^[a-f\d-]{36}$/i;

export class ConversationRetention {
  private readonly file: string;
  private readonly dataDirectory: string;
  private readonly now: () => number;
  private pruning: Promise<string[]> | null = null;
  private readonly home: string;
  private readonly coordinator: ReturnType<typeof storageCoordinator>;
  cleanupHealth: CleanupHealth = { state: 'healthy', issues: [] };
  constructor(privateHome: string, dataDirectory: string, now: () => number = Date.now) {
    this.file = join(privateHome, 'history-index.json');
    this.dataDirectory = dataDirectory;
    this.now = now;
    this.home = resolve(privateHome);
    this.coordinator = storageCoordinator(dataDirectory);
  }
  private read(file = this.file): Index {
    let data: any;
    try { data = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.entries(data).some(([id, value]) => {
      const record = value as Record;
      return !validId.test(id) || !record || !Number.isFinite(record.updatedAt) || !Array.isArray(record.images)
        || record.images.some(image => typeof image !== 'string' || !/^[a-f0-9]{64}$/.test(image))
        || (record.tasks !== undefined && (!Array.isArray(record.tasks) || record.tasks.some(id => typeof id !== 'string' || !validId.test(id))))
        || (record.deleted !== undefined && typeof record.deleted !== 'boolean')
        || (record.providerThreadId !== undefined && !validId.test(record.providerThreadId))
        || (record.retiredProviderThreads !== undefined && (!Array.isArray(record.retiredProviderThreads) || record.retiredProviderThreads.some(id => !validId.test(id))))
        || (record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0));
    })) throw new Error('Invalid application history index');
    return data;
  }
  private write(data: Index): void {
    writeAtomicSync(this.file, JSON.stringify(data));
  }
  get hasRecords(): boolean { return Object.keys(this.read()).length > 0; }
  providerThreadFor(id: string): string | undefined { return this.read()[id]?.providerThreadId; }
  retiredProviderThreadsFor(id: string): string[] { return this.read()[id]?.retiredProviderThreads ?? []; }
  touch(threadId: string, images: GeneratedImage[] = [], task?: ImageTask, providerThreadId?: string): void {
    const prepared = this.prepareTouch(threadId, images, task, providerThreadId);
    try { writeAtomicSync(prepared.file, prepared.contents); }
    finally { prepared.release(); }
  }
  // The transaction owner holds this lease until all prepared files commit or roll back.
  prepareTouch(threadId: string, images: GeneratedImage[] = [], task?: ImageTask | ImageTask[], providerThreadId?: string, rebind = false): { file: string; contents: string; release: () => void } {
    const tasks = task ? Array.isArray(task) ? task : [task] : [];
    if (!validId.test(threadId) || images.some(image => !/^[a-f0-9]{64}$/.test(image.id))
      || tasks.some(task => !validId.test(task.threadId)) || (providerThreadId && !validId.test(providerThreadId))) throw new Error('Invalid conversation ID or image reference');
    const release = this.coordinator.lease(conversationStorageKey(this.home, threadId));
    const releaseTasks: (() => void)[] = [];
    try {
      for (const task of tasks) releaseTasks.push(this.coordinator.lease(conversationStorageKey(join(this.dataDirectory, 'imagegen-codex'), task.threadId)));
      const data = this.read();
      if (data[threadId]?.deleted) throw new Error('Cannot renew a deleted conversation');
      const previousProvider = data[threadId]?.providerThreadId;
      const changedProvider = providerThreadId && previousProvider && previousProvider !== providerThreadId;
      if (changedProvider && !rebind) throw new Error('Conversation provider identity changed');
      const imageIndex = tasks.length ? this.read(join(this.dataDirectory, 'imagegen-codex', 'history-index.json')) : {};
      if (tasks.some(task => imageIndex[task.threadId]?.deleted)) {
        throw new Error('Cannot reference a deleted image task');
      }
      data[threadId] = { updatedAt: this.now(), revision: (data[threadId]?.revision ?? 0) + 1,
        ...(data[threadId]?.retiredProviderThreads?.length || changedProvider ? { retiredProviderThreads:
          [...new Set([...(data[threadId]?.retiredProviderThreads ?? []), ...(changedProvider ? [previousProvider!] : [])])] } : {}),
        ...((providerThreadId ?? data[threadId]?.providerThreadId) && { providerThreadId: providerThreadId ?? data[threadId]?.providerThreadId }),
        images: [...new Set([...(data[threadId]?.images || []), ...images.map(image => image.id)])],
        tasks: [...new Set([...(data[threadId]?.tasks || []), ...tasks.map(task => task.threadId)])] };
      return { file: this.file, contents: JSON.stringify(data), release: () => { releaseTasks.forEach(release => release()); release(); } };
    } catch (error) { releaseTasks.forEach(release => release()); release(); throw error; }
  }
  acquireActivity(threadId?: string | null): Promise<() => void> {
    if (threadId && !validId.test(threadId)) return Promise.reject(new Error('Invalid conversation ID'));
    return this.coordinator.exclusive(() => this.coordinator.lease(conversationStorageKey(this.home, threadId ?? '_external')));
  }
  prune(deleteThread: (id: string) => Promise<void>): Promise<string[]> {
    if (this.pruning) return this.pruning;
    this.pruning = this.coordinator.exclusive(() => this.runPrune(deleteThread)).finally(() => { this.pruning = null; });
    return this.pruning;
  }
  private async runPrune(deleteThread: (id: string) => Promise<void>): Promise<string[]> {
    // The active mode remains strict; an unreadable neighbouring index only defers maintenance.
    const active = this.read();
    this.cleanupHealth = { state: 'healthy', issues: [] };
    const indexes = this.sharedIndexes();
    if (!indexes) return [];
    const removed: string[] = [];
    const candidates = new Set<string>();
    for (const [id, record] of Object.entries(active)) {
      const freshIndexes = this.sharedIndexes();
      if (!freshIndexes) return removed;
      const protectedTasks = new Set<string>();
      for (const index of freshIndexes) for (const entry of Object.values(index)) {
        if (!entry.deleted && this.now() - entry.updatedAt < HISTORY_TTL_MS) entry.tasks?.forEach(task => protectedTasks.add(task));
      }
      if (!record.deleted && (this.now() - record.updatedAt < HISTORY_TTL_MS || protectedTasks.has(id))) continue;
      const release = this.coordinator.claimDelete(conversationStorageKey(this.home, id));
      if (!release) { this.cleanupHealth = { state: 'deferred', issues: [], reason: 'active-conversation' }; continue; }
      try {
        const latest = this.read()[id];
        if (!latest || latest.updatedAt !== record.updatedAt || (latest.revision ?? 0) !== (record.revision ?? 0)) continue;
        // Only IDs registered by this app in this private home are eligible.
        if (!record.deleted) {
          await deleteThread(id);
          const data = this.read();
          data[id].deleted = true;
          this.write(data);
        }
        await this.remove(join(this.home, `${id}.json`));
        await this.remove(join(this.dataDirectory, 'image-links', `${id}.json`));
        record.images.forEach(image => candidates.add(image));
        removed.push(id);
      } finally { release(); }
    }
    // Content-addressed images can be shared by conversations in different modes.
    const retained = new Set<string>();
    const remaining = this.sharedIndexes();
    // Keep tombstones and their image references so a later retry can finish cleanup.
    if (!remaining) return removed;
    for (const index of remaining) {
      for (const record of Object.values(index)) {
        if (!record.deleted) record.images.forEach(id => retained.add(id));
      }
    }
    const releaseImages = this.coordinator.claimImages();
    if (!releaseImages) {
      this.cleanupHealth = { state: 'deferred', issues: [], reason: 'active-conversation' };
      return removed;
    }
    try {
      // An interrupted exchange can leave verified blobs with no committed reference.
      // Give them a full TTL to be adopted by another operation before collecting them.
      const directory = join(this.dataDirectory, 'images');
      let names: string[] = [];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.png$/.test(name)) continue;
        try {
          const info = await stat(join(directory, name));
          if (info.isFile() && this.now() - info.mtimeMs >= HISTORY_TTL_MS) candidates.add(name.slice(0, -4));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      for (const id of candidates) if (!retained.has(id)) await this.remove(join(this.dataDirectory, 'images', `${id}.png`));
    } finally { releaseImages(); }
    const data = this.read();
    removed.forEach(id => { delete data[id]; });
    if (removed.length) this.write(data);
    return removed;
  }
  private sharedIndexes(): Index[] | null {
    const indexes: Index[] = [];
    for (const mode of ['local', 'realtime', 'imagegen']) {
      const file = join(this.dataDirectory, `${mode}-codex`, 'history-index.json');
      try { indexes.push(this.read(file)); }
      catch (error) { this.cleanupHealth.issues.push({ file, error: error as Error }); }
    }
    if (this.cleanupHealth.issues.length) { this.cleanupHealth.state = 'deferred'; return null; }
    return indexes;
  }
  private async remove(file: string): Promise<void> {
    try { await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
