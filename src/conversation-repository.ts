import * as fs from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { validExchange } from './conversation-model.ts';
import type { ConversationExchange } from './conversation-contract.ts';
import { decodeMetadata, decodeHistory, encodeHistory, UnsupportedStorageVersion } from './conversation-format.ts';

export type LocalHistoryResult =
  | { status: 'loaded'; id: string; exchanges: ConversationExchange[] }
  | { status: 'missing'; id: string }
  | { status: 'corrupt'; id: string; error: Error; preservedFile?: string };

type Filesystem = Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'unlinkSync' | 'mkdirSync'>;
const { writeAtomicSync } = createRequire(import.meta.url)('./atomic-file.cjs') as {
  writeAtomicSync: (file: string, contents: string, filesystem: Filesystem) => void;
};
type Journal = { version: 1; metadata: string | null; history?: { id: string; contents: string | null } };
export type TransactionFile = { file: string; contents: string | null };
type JournalV2 = { version: 2; files: TransactionFile[] };

// One synchronous writer. A prepared journal rolls back on restart; removing it commits.
export class ConversationRepository {
  private readonly journal: string;
  private readonly file: string;
  private readonly filesystem: Filesystem;
  private readonly root: string;
  readonly versioned: boolean;
  constructor(file: string, filesystem: Filesystem = fs, root = dirname(file), options: { versioned?: boolean } = {}) {
    this.file = file;
    this.filesystem = filesystem;
    this.journal = `${file}.commit.json`;
    this.root = resolve(root);
    this.versioned = options.versioned ?? false;
    this.recover();
  }
  private read(file: string): string | null {
    try { return this.filesystem.readFileSync(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  load(): unknown {
    this.recover();
    const content = this.read(this.file);
    if (content === null) return null;
    if (!this.versioned) return JSON.parse(content);
    let decoded: ReturnType<typeof decodeMetadata>;
    try { decoded = decodeMetadata(JSON.parse(content)); }
    catch (error) {
      if (error instanceof UnsupportedStorageVersion) throw error;
      this.filesystem.renameSync(this.file, `${this.file}.corrupt-${randomUUID()}`);
      return null;
    }
    if (decoded.legacy) {
      this.backupLegacy(this.file, content);
      this.commit(JSON.stringify(decoded.metadata));
    }
    return decoded.metadata;
  }
  private backupLegacy(file: string, content: string): void {
    writeAtomicSync(`${file}.legacy-${randomUUID()}`, content, this.filesystem);
  }
  loadHistory(id: string): LocalHistoryResult {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation ID');
    this.recover();
    const content = this.read(join(dirname(this.file), `${id}.json`));
    if (content === null) return { status: 'missing', id };
    if (this.versioned) {
      let decoded: ReturnType<typeof decodeHistory>;
      try { decoded = decodeHistory(JSON.parse(content), id); }
      catch (error) {
        if (error instanceof UnsupportedStorageVersion) throw error;
        return { status: 'corrupt', id, error: error as Error };
      }
      if (decoded.legacy) {
        this.backupLegacy(join(dirname(this.file), `${id}.json`), content);
        this.commit(this.read(this.file), { id, contents: encodeHistory(id, decoded.revision, decoded.exchanges) });
      }
      return { status: 'loaded', id, exchanges: decoded.exchanges };
    }
    try {
      const exchanges: unknown = JSON.parse(content);
      if (!Array.isArray(exchanges) || !exchanges.every(validExchange)) throw new Error('Invalid application conversation');
      return { status: 'loaded', id, exchanges };
    } catch (error) { return { status: 'corrupt', id, error: error as Error }; }
  }
  preserveCorruptHistory(id: string): string {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid conversation ID');
    const file = join(dirname(this.file), `${id}.json`), backup = `${file}.corrupt-${randomUUID()}`;
    this.filesystem.renameSync(file, backup);
    return backup;
  }
  private replace(file: string, contents: string | null): void {
    if (contents === null) {
      try { this.filesystem.unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return;
    }
    writeAtomicSync(file, contents, this.filesystem);
  }
  recover(): void {
    const contents = this.read(this.journal);
    if (contents === null) return;
    const journal: Journal | JournalV2 = JSON.parse(contents);
    if (journal?.version === 2) {
      if (!Array.isArray(journal.files) || journal.files.length < 1 || journal.files.length > 16
        || journal.files.some(entry => !entry || typeof entry.file !== 'string'
          || (entry.contents !== null && typeof entry.contents !== 'string'))) throw new Error('Invalid conversation commit journal');
      const files = journal.files.map(entry => ({ ...entry, file: this.resolveFile(entry.file) }));
      if (new Set(files.map(entry => entry.file)).size !== files.length) throw new Error('Duplicate conversation journal file');
      for (const entry of files.reverse()) this.replace(entry.file, entry.contents);
      this.filesystem.unlinkSync(this.journal);
      return;
    }
    if (journal?.version !== 1 || (journal.metadata !== null && typeof journal.metadata !== 'string')
      || (journal.history !== undefined && (!journal.history || !/^[a-f\d-]{36}$/i.test(journal.history.id)
        || (journal.history.contents !== null && typeof journal.history.contents !== 'string')))) {
      throw new Error('Invalid conversation commit journal');
    }
    if (journal.history) this.replace(join(dirname(this.file), `${journal.history.id}.json`), journal.history.contents);
    this.replace(this.file, journal.metadata);
    this.filesystem.unlinkSync(this.journal);
  }
  private resolveFile(file: string): string {
    const target = resolve(this.root, file), path = relative(this.root, target);
    if (!path || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(path) || target === resolve(this.journal)) throw new Error('Invalid conversation transaction path');
    return target;
  }
  commit(metadata: string | null, history?: { id: string; contents: string }, additional: TransactionFile[] = []): void {
    this.recover();
    if (history && !/^[a-f\d-]{36}$/i.test(history.id)) throw new Error('Invalid conversation ID');
    const historyFile = history && join(dirname(this.file), `${history.id}.json`);
    const changes: TransactionFile[] = [...(history ? [{ file: historyFile!, contents: history.contents }] : []),
      ...additional, { file: this.file, contents: metadata }].map(entry => ({ ...entry, file: this.resolveFile(entry.file) }));
    if (changes.length > 16 || new Set(changes.map(entry => entry.file)).size !== changes.length) throw new Error('Invalid conversation transaction files');
    const journal: JournalV2 = { version: 2, files: changes.map(entry => ({ file: relative(this.root, entry.file), contents: this.read(entry.file) })) };
    this.replace(this.journal, JSON.stringify(journal));
    try {
      for (const entry of changes) this.replace(entry.file, entry.contents);
      this.filesystem.unlinkSync(this.journal);
    } catch (error) {
      // If rollback also fails, retain the journal and require recovery before another commit.
      try { this.recover(); } catch { /* Original commit error is the actionable failure. */ }
      throw error;
    }
  }
}
