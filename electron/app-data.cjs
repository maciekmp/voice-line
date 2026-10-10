const path = require('node:path');
const os = require('node:os');

// Shared by the Electron host and Node voice worker. Resolving a path has no side effects.
function appDataDirectory(env = process.env) {
  if (env.CHATGPT_BUTTON_DATA_DIR?.trim()) return path.resolve(env.CHATGPT_BUTTON_DATA_DIR.trim());
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ChatGPTButton');
}
module.exports = { appDataDirectory };
