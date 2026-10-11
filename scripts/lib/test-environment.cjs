const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRoot } = require('./project.cjs');

function createTestEnvironment(suite, inherited = process.env) {
  const parent = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'voice-line-tests-'));
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => {
    const key = name.toUpperCase();
    return !/^(OPENAI_|CODEX_|WHISPER_|STT_|PIPER_)/.test(key)
      && !['VOICE', 'TTS_RATE', 'APP_DATA_DIR', 'NODE_BIN', 'TEST_OUTPUT_DIR', 'VOICE_MODE', 'TTS_MODE', 'MIC_DEVICE', 'COPILOT_VK', 'SAVE_AUDIO',
        'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY',
        'ALL_PROXY', 'NO_PROXY'].includes(key);
  }));
  env.APP_DATA_DIR = path.join(directory, 'data');
  env.CODEX_HOME = path.join(directory, 'codex');
  env.CODEX_SQLITE_HOME = env.CODEX_HOME;
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  let outputDirectory;
  if (suite === 'desktop') {
    outputDirectory = path.join(projectRoot, '.app-data', 'test-results', `desktop-${path.basename(directory).slice('voice-line-tests-'.length)}`);
    env.TEST_OUTPUT_DIR = outputDirectory;
  }
  return { directory, env, outputDirectory, cleanup() {
    // Remove only the exact directory created here, never an env-provided path.
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith('voice-line-tests-')) {
      throw new Error('Refusing to remove a directory outside the test workspace');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } };
}

module.exports = { createTestEnvironment };
