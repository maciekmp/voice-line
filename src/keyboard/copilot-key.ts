import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { launch } from '../process.ts';

export type KeyEvent = { event: 'down' | 'up'; vk: number; scan: number; flags: number };
export function startKeyboard(onEvent: (event: KeyEvent) => void, onError: (message: string) => void) {
  const script = fileURLToPath(new URL('./bridge.ps1', import.meta.url));
  const child = launch('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  createInterface({ input: child.stdout }).on('line', line => {
    try { onEvent(JSON.parse(line)); } catch { onError(`Keyboard bridge: ${line}`); }
  });
  child.stderr.setEncoding('utf8').on('data', onError);
  child.on('exit', code => onError(`Keyboard bridge exited (${code})`));
  return { stop: () => child.kill() };
}
