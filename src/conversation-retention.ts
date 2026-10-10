import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneratedImage, ImageTask } from './image-artifacts.ts';

export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
type Record = { updatedAt: number; images: string[]; tasks?: string[]; deleted?: boolean };
type Index = { [threadId: string]: Record };
const validId = /^[a-f\d-]{36}$/i;

export class ConversationRetention {
  private readonly file: string;
  private readonly dataDirectory: string;
  private readonly now: () => number;
  private pruning: Promise<string[]> | null = null;
  constructor(privateHome: string, dataDirectory: string, now: () => number = Date.now) {
    this.file = join(privateHome, 'history-index.json');
    this.dataDirectory = dataDirectory;
    this.now = now;
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
        || (record.deleted !== undefined && typeof record.deleted !== 'boolean');
    })) throw new Error('Invalid application history index');
    return data;
  }
  private write(data: Index): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(data), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }
  get hasRecords(): boolean { return Object.keys(this.read()).length > 0; }
  touch(threadId: string, images: GeneratedImage[] = [], task?: ImageTask): void {
    if (!validId.test(threadId) || images.some(image => !/^[a-f0-9]{64}$/.test(image.id))
      || (task && !validId.test(task.threadId))) throw new Error('Invalid conversation ID or image reference');
    const data = this.read();
    data[threadId] = { updatedAt: this.now(), images: [...new Set([...(data[threadId]?.images || []), ...images.map(image => image.id)])],
      tasks: [...new Set([...(data[threadId]?.tasks || []), ...(task ? [task.threadId] : [])])] };
    this.write(data);
  }
  prune(deleteThread: (id: string) => Promise<void>): Promise<string[]> {
    if (this.pruning) return this.pruning;
    this.pruning = this.runPrune(deleteThread).finally(() => { this.pruning = null; });
    return this.pruning;
  }
  private async runPrune(deleteThread: (id: string) => Promise<void>): Promise<string[]> {
    const removed: string[] = [];
    const candidates = new Set<string>();
    const protectedTasks = new Set<string>();
    for (const mode of ['local', 'realtime', 'imagegen']) {
      for (const record of Object.values(this.read(join(this.dataDirectory, `${mode}-codex`, 'history-index.json')))) {
        if (!record.deleted && this.now() - record.updatedAt < HISTORY_TTL_MS) record.tasks?.forEach(id => protectedTasks.add(id));
      }
    }
    for (const [id, record] of Object.entries(this.read())) {
      if (!record.deleted && (this.now() - record.updatedAt < HISTORY_TTL_MS || protectedTasks.has(id))) continue;
      // Only IDs registered by this app in this private home are eligible.
      if (!record.deleted) {
        await deleteThread(id);
        const data = this.read();
        data[id].deleted = true;
        this.write(data);
      }
      await this.remove(join(this.dataDirectory, 'image-links', `${id}.json`));
      record.images.forEach(image => candidates.add(image));
      removed.push(id);
    }
    // Content-addressed images can be shared by conversations in different modes.
    const retained = new Set<string>();
    for (const mode of ['local', 'realtime', 'imagegen']) {
      for (const record of Object.values(this.read(join(this.dataDirectory, `${mode}-codex`, 'history-index.json')))) {
        if (!record.deleted) record.images.forEach(id => retained.add(id));
      }
    }
    for (const id of candidates) if (!retained.has(id)) await this.remove(join(this.dataDirectory, 'images', `${id}.png`));
    const data = this.read();
    removed.forEach(id => { delete data[id]; });
    if (removed.length) this.write(data);
    return removed;
  }
  private async remove(file: string): Promise<void> {
    try { await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
