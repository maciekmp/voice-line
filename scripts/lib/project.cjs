const path = require('node:path');

const projectRoot = path.resolve(__dirname, '../..');

function loadProjectEnv() {
  try { process.loadEnvFile(path.join(projectRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

module.exports = { projectRoot, loadProjectEnv };
