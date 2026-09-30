import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function launch(command: string, args: string[], options: { cwd?: string } = {}): ChildProcessWithoutNullStreams {
  const childEnv = { ...process.env };
  if (command.toLowerCase().includes('codex')) {
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
  }
  if (process.platform === 'win32' && command.toLowerCase() === 'codex.cmd') {
    const located = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/)[0];
    const entry = located && join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (entry && existsSync(entry)) return spawn(process.execPath, [entry, ...args], { ...options, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  return spawn(command, args, { ...options, env: childEnv, windowsHide: true, shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'), stdio: ['pipe', 'pipe', 'pipe'] });
}

export function collect(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const abort = () => { child.kill(); reject(new Error('Cancelled')); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => { signal?.removeEventListener('abort', abort); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}
