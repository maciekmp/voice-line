import { resolve } from 'node:path';
import { ArtifactStore } from './artifact-store.ts';
export type { GeneratedImage, ImageTask } from './conversation-contract.ts';
export type { ImageLink } from './artifact-store.ts';
import type { GeneratedImage } from './conversation-contract.ts';
import type { ImageLink } from './artifact-store.ts';

// Compatibility functions delegate to the shared store used by providers and history hydration.
function store(cwd: string, dataDirectory?: string): ArtifactStore {
  return new ArtifactStore(dataDirectory ?? resolve(cwd, '.app-data'));
}
export function readImageLinks(cwd: string, threadId: string, dataDirectory?: string): Promise<ImageLink[]> {
  return store(cwd, dataDirectory).readLinks(threadId);
}
export function appendImageLink(cwd: string, threadId: string, link: ImageLink, dataDirectory?: string): Promise<void> {
  return store(cwd, dataDirectory).appendLink(threadId, link);
}
export function storeGeneratedImage(cwd: string, item: any, dataDirectory?: string): Promise<GeneratedImage> {
  return store(cwd, dataDirectory).ensureProtocolImage(item);
}

// Explicit generation requests only; ordinary questions about images remain text turns.
export function imageRequest(text: string): string | null {
  const explicit = explicitImageRequest(text);
  if (explicit) return explicit;
  return /^\s*(?:proszę[,]?\s+)?(?:wygeneruj|narysuj|stwórz|generate|draw|create)\b[\s\S]*\b(?:obraz(?:ek)?|zdjęcie|ilustrację|grafikę|image|picture|photo|illustration)(?=\s|[.,!?]|$)/i.test(text) ? text.trim() : null;
}
export function explicitImageRequest(text: string): string | null {
  const command = text.match(/^\s*\/image\s+([\s\S]+)$/i);
  return command ? command[1].trim() : null;
}
