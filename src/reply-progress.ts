import type { ImageProgress, ReplyProgress } from './conversation-contract.ts';

// Preserve the existing positional API and omit absent callbacks for legacy adapters.
export function progressCallbacks(onImages?: ImageProgress, onText?: ReplyProgress): [onImages?: ImageProgress, onText?: ReplyProgress] {
  return onText ? [onImages, onText] : onImages ? [onImages] : [];
}
