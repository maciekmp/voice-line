import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { GeneratedImage } from './conversation-contract.ts';

// Admission verifies the canonical blob, never a path supplied by a renderer.
export function verifyImportedImage(directory: string, image: GeneratedImage): GeneratedImage {
  if (!/^[a-f0-9]{64}$/.test(image.id)) throw new Error('Invalid image ID');
  const file = join(directory, 'images', `${image.id}.png`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid image size');
  const bytes = readFileSync(file);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)
    || createHash('sha256').update(bytes).digest('hex') !== image.id) throw new Error('Invalid PNG');
  return { id: image.id, alt: image.alt.slice(0, 2000) || 'Załączony obraz' };
}
