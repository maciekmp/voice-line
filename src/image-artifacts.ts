import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type GeneratedImage = { id: string; alt: string };
export type ImageTask = { threadId: string; turnId: string };
export type ImageLink = ImageTask & { anchor: number };
function linksFile(cwd: string, threadId: string, dataDirectory = resolve(cwd, '.chatgpt-button')): string {
  if (!/^[a-f\d-]{36}$/i.test(threadId)) throw new Error('Invalid image conversation ID');
  return resolve(dataDirectory, 'image-links', `${threadId}.json`);
}
export async function readImageLinks(cwd: string, threadId: string, dataDirectory?: string): Promise<ImageLink[]> {
  let data: unknown;
  try { data = JSON.parse(await readFile(linksFile(cwd, threadId, dataDirectory), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(data) || data.some(link => !link || !Number.isSafeInteger(link.anchor) || link.anchor < 0
    || typeof link.threadId !== 'string' || !/^[a-f\d-]{36}$/i.test(link.threadId)
    || typeof link.turnId !== 'string' || !/^[a-z\d_-]{1,128}$/i.test(link.turnId))) throw new Error('Invalid image history links');
  return data;
}
export async function appendImageLink(cwd: string, threadId: string, link: ImageLink, dataDirectory?: string): Promise<void> {
  const links = await readImageLinks(cwd, threadId, dataDirectory);
  const file = linksFile(cwd, threadId, dataDirectory);
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify([...links, link]), 'utf8');
  await rename(`${file}.tmp`, file);
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export async function storeGeneratedImage(cwd: string, item: any, dataDirectory = resolve(cwd, '.chatgpt-button')): Promise<GeneratedImage> {
  if (item.status !== 'completed' || typeof item.result !== 'string' || !item.result
    || item.result.length > 45_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.result)) throw new Error('ImageGen nie zwrócił poprawnego obrazu.');
  const bytes = Buffer.from(item.result, 'base64');
  if (bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== item.result || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('ImageGen nie zwrócił obrazu PNG.');
  const id = createHash('sha256').update(bytes).digest('hex');
  const directory = resolve(dataDirectory, 'images');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${id}.png`), bytes);
  return { id, alt: typeof item.revisedPrompt === 'string' ? item.revisedPrompt.slice(0, 2000) : 'Wygenerowany obraz' };
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
