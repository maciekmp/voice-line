const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { projectRoot } = require('./lib/project.cjs');
const { createTestEnvironment } = require('./lib/test-environment.cjs');

const integrationFiles = ['test-speaker.ts', 'test-storage-wire.ts', 'test-realtime-wire.ts'];
function selectSuite(group, args = []) {
  if (!['unit', 'integration', 'desktop', 'keyboard'].includes(group)) {
    throw new Error('Usage: node scripts/run-tests.cjs unit|integration|desktop|keyboard [test-file] [Node test options]');
  }
  if (group === 'desktop' || group === 'keyboard') {
    if (args.length) throw new Error(`${group} does not accept additional arguments`);
    return { group, files: [], nodeOptions: [] };
  }
  const directory = path.join(projectRoot, 'tests', group);
  let files = group === 'unit'
    ? fs.readdirSync(directory).filter(name => /^test-.+\.(?:ts|js|cjs)$/.test(name)).sort()
    : integrationFiles;
  const options = [...args];
  if (options[0] && !options[0].startsWith('--')) {
    const selected = options.shift();
    if (!files.includes(selected)) throw new Error(`Unknown ${group} test file: ${selected}`);
    files = [selected];
  }
  if (!files.length) throw new Error(`No ${group} tests found`);
  if (group === 'integration' && options.length) throw new Error('Integration scripts do not accept Node test options');
  // Only test-runner options may be forwarded, never --env-file/--import/--require.
  for (let i = 0; i < options.length; i++) {
    if (!/^--test-(?:name-pattern|skip-pattern|reporter|reporter-destination|concurrency|timeout)(?:=|$)/.test(options[i])) {
      throw new Error(`Unsupported Node test option: ${options[i]}`);
    }
    if (!options[i].includes('=')) {
      if (!options[i + 1] || options[i + 1].startsWith('--')) throw new Error(`Missing value for ${options[i]}`);
      i++;
    }
  }
  return { group, files: files.map(file => path.join(directory, file)), nodeOptions: options };
}

function runProcess(command, args, env) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: projectRoot, env, shell: false, windowsHide: true, stdio: 'inherit' });
    let failed = false;
    let interrupted = false;
    const interrupt = () => { interrupted = true; child.kill(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', error => { failed = true; console.error(error.message); });
    child.once('close', code => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      resolve(interrupted ? 130 : failed ? 1 : code ?? 1);
    });
  });
}

async function runSuite(selection) {
  const environment = createTestEnvironment(selection.group);
  let code = 1;
  try {
    if (selection.group === 'desktop') {
      console.log(`Desktop captures: ${environment.outputDirectory}`);
      code = await runProcess(require('electron'), [path.join(projectRoot, 'electron', 'orb-main.cjs'), '--smoke-test'], environment.env);
    } else if (selection.group === 'keyboard') {
      code = await runProcess(process.execPath, ['--experimental-strip-types', '--test',
        path.join(projectRoot, 'tests/native/test-keyboard.ts')], environment.env);
    } else if (selection.group === 'unit') {
      code = await runProcess(process.execPath, ['--experimental-strip-types', '--test',
        ...selection.nodeOptions, ...selection.files], environment.env);
    } else {
      for (const file of selection.files) {
        console.log(`Integration: ${path.basename(file)}`);
        code = await runProcess(process.execPath, ['--experimental-strip-types', file], environment.env);
        if (code !== 0) break;
      }
    }
  } finally {
    try { environment.cleanup(); }
    catch (error) { console.error(`Test cleanup failed (${environment.directory}): ${error.message}`); code = 1; }
  }
  return code;
}

if (require.main === module) {
  Promise.resolve().then(() => runSuite(selectSuite(process.argv[2], process.argv.slice(3))))
    .then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { selectSuite, runSuite };
