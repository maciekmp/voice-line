const { spawn } = require('node:child_process');
const path = require('node:path');

// Some Electron-based terminals export this flag; the orb needs GUI mode.
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
const child = spawn(require('electron'), [path.join(__dirname, '..', 'electron', 'orb-main.cjs'), ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true, env,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
