import { createApplicationRuntime } from './application-runtime.ts';
import { createWorkerRequestHandler } from './worker-host.ts';
import { createReadinessReporter } from './service-status.ts';

if (!process.connected) {
  console.error('The application worker requires an IPC host. Use npm start or npm run start:cli.');
  process.exitCode = 1;
} else {
  const reportReadiness = createReadinessReporter(message => console.log(message));
  const runtime = createApplicationRuntime(event => {
    if (event.type === 'voice') reportReadiness(event);
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
