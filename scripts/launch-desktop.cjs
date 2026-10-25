const { spawn } = require('node:child_process');
const path = require('node:path');
const { loadProjectEnv, projectRoot } = require('./lib/project.cjs');
if (process.argv.includes('--smoke-test')) {
  console.error('Use npm run test:desktop to run the smoke test with isolated data.');
  process.exit(1);
}
// Only a real application launch needs production configuration.
if (!process.argv.includes('--preview')) loadProjectEnv();

// Some Electron-based terminals export this flag; the desktop host needs GUI mode.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
// Electron reserves --debug for Node's removed debugger; use an application flag.
const appArgs = process.argv.slice(2).map(arg => arg === '--debug' ? '--app-debug' : arg);
const child = spawn(require('electron'), [path.join(projectRoot, 'electron', 'desktop-main.cjs'), ...appArgs], {
  cwd: projectRoot, stdio: 'inherit', windowsHide: true, env: { ...env, NODE_BIN: process.execPath },
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
