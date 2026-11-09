import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export function launch(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcessWithoutNullStreams {
  const childEnv = { ...process.env, ...options.env };
  if (command.toLowerCase().includes('codex')) {
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
  }
  if (process.platform === 'win32' && basename(command).toLowerCase() === 'codex.cmd') {
    const locate = (name: string) => spawnSync('where.exe', [name], {
      encoding: 'utf8', windowsHide: true, env: childEnv, ...(options.cwd && { cwd: options.cwd }),
    }).stdout?.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    const explicitPath = /[\\/]/.test(command);
    const located = explicitPath ? resolve(options.cwd ?? '.', command) : locate('codex.cmd');
    const entry = located && existsSync(located) && join(dirname(located), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
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
    // Standalone and editor installations can expose only the native executable.
    const executable = !explicitPath && locate('codex.exe');
    if (executable) return spawn(executable, args, { ...options, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
    // cmd.exe reparses argv (including model names and filesystem paths). A
    // fallback shell would turn metacharacters into commands and lose quoting.
    throw new Error('Cannot safely launch a Windows batch script. Use a native executable, or install @openai/codex with npm so its JavaScript entry point can be used.');
  }
  return spawn(command, args, { ...options, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function collect(child: ChildProcessWithoutNullStreams, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const abort = () => {
      // On older Windows Node versions, killing a failed spawn can synchronously
      // emit an EINVAL error. Cancellation must win over that secondary failure.
      reject(new Error('Cancelled'));
      if (child.pid) child.kill();
    };
    // A failed spawn emits its error asynchronously, even when an already-aborted
    // caller has cancelled it. Keep listeners installed before taking that path.
    child.once('error', error => { signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => { signal?.removeEventListener('abort', abort); resolve({ stdout, stderr, code: code ?? 1 }); });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}
