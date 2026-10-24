import { createApplicationRuntime } from './application-runtime.ts';
import { createWorkerRequestHandler } from './worker-host.ts';

if (!process.connected) {
  console.error('The application worker requires an IPC host. Use npm start or npm run start:cli.');
  process.exitCode = 1;
} else {
  const runtime = createApplicationRuntime(event => {
    if (process.connected) process.send?.(event, error => { if (error) void shutdown(); });
  }, { debug: process.argv.includes('--debug') });
  let closing: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    if (!closing) closing = runtime.shutdown().then(() => { if (process.connected) process.disconnect?.(); });
    return closing;
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('disconnect', () => { void shutdown(); });
  process.on('message', createWorkerRequestHandler(runtime, shutdown, response => {
    if (process.connected) process.send?.(response, error => { if (error) void shutdown(); });
  }));
  void runtime.start();
}
