import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/voice-orb.js', ['voice-orb.js', 'text/javascript; charset=utf-8']],
  ['/orb-renderer.js', ['orb-renderer.js', 'text/javascript; charset=utf-8']],
]);

const server = createServer(async (request, response) => {
  const file = files.get(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(new URL(`../preview/${file[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
    response.end(content);
  } catch {
    response.writeHead(500).end('Preview could not be loaded');
  }
});

server.on('error', (error) => {
  console.error(`Orb preview: ${error.message}`);
  process.exitCode = 1;
});
server.listen(4173, '127.0.0.1', () => {
  console.log('Orb preview: http://127.0.0.1:4173 (Ctrl+C to stop)');
});
