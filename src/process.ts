import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export function launch(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const childEnv = { ...process.env, ...options.env };
  if (command.toLowerCase().includes('codex')) {
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
  }
  if (process.platform === 'win32' && command.toLowerCase() === 'codex.cmd') {
    const located = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8', windowsHide: true }).stdout?.split(/\r?\n/)[0];
    const entry = located && join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (entry && existsSync(entry)) {
      // Own the native process so cancelling/stopping also closes its realtime socket.
      // Killing the JavaScript launcher on Windows can leave codex.exe running.
      try {
        const platformPackage = createRequire(entry).resolve(`@openai/codex-win32-${process.arch}/package.json`);
        const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
        const executable = join(dirname(platformPackage), 'vendor', target, 'bin', 'codex.exe');
        if (existsSync(executable)) return spawn(executable, args, { ...options, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { /* Older packages keep the existing launcher fallback. */ }
      return spawn(process.execPath, [entry, ...args], { ...options, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    }
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
