import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { GeneratedImage, ImageTask } from './conversation-contract.ts';
import { storageCoordinator } from './storage-coordinator.ts';
import type { TransactionFile } from './conversation-repository.ts';
import { imageId, type ImageId } from './conversation-identifiers.ts';

const { writeAtomic } = createRequire(import.meta.url)('./atomic-file.cjs') as {
  writeAtomic: (file: string, contents: string | Buffer) => Promise<void>;
};
export type ImageLink = ImageTask & { anchor: number };
const validConversation = /^[a-f\d-]{36}$/i;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function imageFromProtocol(item: any): { image: GeneratedImage & { id: ImageId }; bytes: Buffer } {
  if (!item || item.status !== 'completed' || typeof item.result !== 'string' || !item.result
    || item.result.length > 45_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.result)) throw new Error('ImageGen nie zwrócił poprawnego obrazu.');
  const bytes = Buffer.from(item.result, 'base64');
  if (bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== item.result || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('ImageGen nie zwrócił obrazu PNG.');
  return { bytes, image: { id: imageId(createHash('sha256').update(bytes).digest('hex')),
    alt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt.slice(0, 2000) : 'Wygenerowany obraz' } };
}
export function validImageLink(link: any): link is ImageLink {
  return !!link && Number.isSafeInteger(link.anchor) && link.anchor >= 0 && typeof link.threadId === 'string'
    && validConversation.test(link.threadId) && typeof link.turnId === 'string' && /^[a-z\d_-]{1,128}$/i.test(link.turnId);
}

export class ArtifactStore {
  readonly directory: string;
  private readonly coordinator: ReturnType<typeof storageCoordinator>;
  constructor(directory: string) {
    this.directory = resolve(directory);
    this.coordinator = storageCoordinator(this.directory);
  }
  private linksFile(conversationId: string): string {
    if (!validConversation.test(conversationId)) throw new Error('Invalid image conversation ID');
    return resolve(this.directory, 'image-links', `${conversationId}.json`);
  }
  async readLinks(conversationId: string): Promise<ImageLink[]> {
    let data: unknown;
    try { data = JSON.parse(await readFile(this.linksFile(conversationId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (!Array.isArray(data) || !data.every(validImageLink)) throw new Error('Invalid image history links');
    return data;
  }
  async appendLink(conversationId: string, link: ImageLink): Promise<void> {
    const file = this.linksFile(conversationId);
    if (!validImageLink(link)) return Promise.reject(new Error('Invalid image history link'));
    return this.coordinator.exclusive(async () => {
      const links = await this.readLinks(conversationId);
      // The remote task identity is stable across retries, even if the local anchor moved.
      if (links.some(existing => existing.threadId === link.threadId && existing.turnId === link.turnId)) return;
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeAtomic(file, JSON.stringify([...links, link]));
    });
  }
  // Called inside the storage coordinator's exclusive commit, before any files change.
  prepareLink(conversationId: string, link: ImageLink): TransactionFile | null {
    const file = this.linksFile(conversationId);
    if (!validImageLink(link)) throw new Error('Invalid image history link');
    let links: ImageLink[] = [];
    try {
      links = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(links) || !links.every(validImageLink)) throw new Error('Invalid image history links');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (links.some(existing => existing.threadId === link.threadId && existing.turnId === link.turnId)) return null;
    return { file, contents: JSON.stringify([...links, link]) };
  }
  ensure(image: GeneratedImage, bytes: Buffer): Promise<GeneratedImage> {
    if (!/^[a-f0-9]{64}$/.test(image.id) || !bytes.subarray(0, 8).equals(pngSignature)
      || bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== image.id) {
      return Promise.reject(new Error('Invalid content-addressed PNG'));
    }
    return this.coordinator.exclusive(async () => {
      const directory = resolve(this.directory, 'images'), file = resolve(directory, `${image.id}.png`);
      await mkdir(directory, { recursive: true });
      try {
        const existing = await readFile(file);
        if (existing.equals(bytes)) return image;
        // Preserve a damaged blob before replacing it with the verified protocol result.
        await copyFile(file, `${file}.corrupt-${randomUUID()}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await writeAtomic(file, bytes);
      return image;
    });
  }
  async ensureProtocolImage(item: any): Promise<GeneratedImage> {
    const { image, bytes } = imageFromProtocol(item);
    return this.ensure(image, bytes);
  }
}
