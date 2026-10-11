const path = require('node:path');
const os = require('node:os');

// Resolving the shared host/worker data root has no filesystem side effects.
function appDataDirectory(env = process.env) {
  if (env.APP_DATA_DIR?.trim()) return path.resolve(env.APP_DATA_DIR.trim());
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VoiceLine');
}
module.exports = { appDataDirectory };
