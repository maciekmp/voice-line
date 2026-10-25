import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { ArtifactStore } from './artifact-store.ts';
export type { GeneratedImage, ImageTask } from './conversation-contract.ts';
export type { ImageLink } from './artifact-store.ts';
export const IMAGE_OUTPUT_INSTRUCTIONS = 'Uwzględnij liczbę obrazów lub wariantów podaną przez użytkownika. Jeśli nie podał liczby, wygeneruj jeden obraz. Gdy prosi o kilka obrazów, zwróć je jako osobne obrazy, nie kolaż ani siatkę, chyba że o to prosi. Jeśli narzędzie zwraca jeden obraz na wywołanie, wykonaj osobne wywołania dla kolejnych wariantów w ramach tej odpowiedzi. Nie zastępuj obrazów opisem ani kodem SVG. Jeśli narzędzie lub limity nie pozwalają uzyskać całej liczby, zachowaj uzyskane obrazy i nie twierdź, że powstały brakujące.';
import type { GeneratedImage } from './conversation-contract.ts';
import type { ImageLink } from './artifact-store.ts';
const { readImage, imagePath } = createRequire(import.meta.url)('./image-files.cjs') as {
  readImage(directory: string, id: string): Promise<Buffer>;
  imagePath(directory: string, id: string): string;
};

export async function imageAttachmentPath(cwd: string, id: string, dataDirectory?: string): Promise<string> {
  const directory = resolve(dataDirectory ?? resolve(cwd, '.app-data'), 'images');
  try {
    await readImage(directory, id);
    return imagePath(directory, id);
  } catch { throw new Error('Wybrany obraz jest niedostępny. Wybierz inny obraz lub usuń załącznik.'); }
}

// Verified artifacts determine generation success, rather than the model's prose.
export function imageGenerationAnswer(answer: string, images?: GeneratedImage[], failedResults = 0): string {
  if (!images?.length) return answer;
  const warning = ' Nie wszystkie próby generowania zakończyły się poprawnie.';
  return (images.length === 1 ? 'Wygenerowano obraz.' : 'Wygenerowano obrazy.')
    + (failedResults > 0 || answer.endsWith(warning) ? warning : '');
}

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
