import { parseInputCommand, type WorkerResult } from './application-contract.ts';
import type { ApplicationRuntime } from './application-runtime.ts';

// Process transport is intentionally separate from service construction, allowing
// the real protocol to be exercised without audio devices or provider requests.
export function createWorkerRequestHandler(runtime: Pick<ApplicationRuntime, 'dispatch'>, shutdown: () => Promise<void>,
  reply: (value: WorkerResult) => void) {
  return (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const message = value as { type?: unknown; requestId?: unknown; command?: unknown };
    if (message.type === 'request' && Number.isSafeInteger(message.requestId) && Number(message.requestId) > 0) {
      const command = parseInputCommand(message.command);
      const receipt = runtime.dispatch(command);
      reply({ type: 'command-result', requestId: Number(message.requestId), result: receipt.result });
      if (command?.command === 'shutdown') void shutdown();
      return true;
    }
    if (message.command === 'shutdown') { void shutdown(); return true; }
    return false;
  };
}
