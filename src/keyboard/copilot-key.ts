import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch } from '../process.ts';

export type KeyEvent = { event: 'down' | 'up'; vk: number; scan: number; flags: number };
export function startKeyboard(onEvent: (event: KeyEvent) => void, onError: (message: string) => void,
  options: { suppressVk?: number; onReady?: () => void } = {}) {
  const suppressVk = options.suppressVk ?? 0;
  if (!Number.isInteger(suppressVk) || suppressVk < 0 || suppressVk > 255) throw new Error('Copilot virtual key must be an integer from 1 to 255 (0 disables suppression).');
  const script = fileURLToPath(new URL('./bridge.ps1', import.meta.url));
  const child = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-SuppressVk', String(suppressVk), '-ParentPid', String(process.pid)]);
  let stopping = false;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.type === 'ready') options.onReady?.();
      else onEvent(value);
    } catch { if (!stopping) onError(`Keyboard bridge: ${line}`); }
  });
  child.stderr.setEncoding('utf8').on('data', message => { if (!stopping) onError(message); });
  child.on('error', error => { if (!stopping) onError(`Keyboard bridge: ${error.message}`); });
  child.on('exit', code => { if (!stopping) onError(`Keyboard bridge exited (${code})`); });
  return { pid: child.pid, stop: () => { stopping = true; child.kill(); return closed; } };
}
