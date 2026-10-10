/** @param {{load: (id: string) => Promise<string | null>, maxEntries?: number, maxBytes?: number}} options */
export function createImagePreviewCache({ load, maxEntries = 24, maxBytes = 16 * 1024 * 1024 }) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('Invalid preview cache limits');
  /** @type {Map<string, {url: string, bytes: number}>} */
  const cached = new Map();
  /** @type {Map<string, Promise<string | null>>} */
  const pending = new Map();
  let bytes = 0, requests = 0, hits = 0;
  return {
    /** @param {string} id @returns {Promise<string | null>} */
    get(id) {
      const entry = cached.get(id);
      if (entry) {
        cached.delete(id); cached.set(id, entry); hits++;
        return Promise.resolve(entry.url);
      }
      const existing = pending.get(id);
      if (existing) { hits++; return existing; }
      requests++;
      const request = Promise.resolve().then(() => load(id)).then(url => {
        if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,')) return null;
        const size = url.length * 2; // Conservative UTF-16 upper bound for the retained string.
        if (size <= maxBytes) {
          cached.set(id, { url, bytes: size }); bytes += size;
          while (cached.size > maxEntries || bytes > maxBytes) {
            const oldest = cached.keys().next().value;
            if (oldest === undefined) break;
            const removed = cached.get(oldest);
            if (!removed) break;
            bytes -= removed.bytes; cached.delete(oldest);
          }
        }
        return url;
      }).finally(() => pending.delete(id));
      pending.set(id, request);
      return request;
    },
    /** @param {string} id */
    invalidate(id) {
      const entry = cached.get(id);
      if (entry) { bytes -= entry.bytes; cached.delete(id); }
    },
    get stats() { return { entries: cached.size, bytes, pending: pending.size, requests, hits, maxEntries, maxBytes }; },
  };
}
