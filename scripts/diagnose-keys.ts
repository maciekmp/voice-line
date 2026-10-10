import { startKeyboard } from '../src/keyboard/copilot-key.ts';

let stopping = false;
const keyboard = startKeyboard(event => {
  console.log(`${event.event.toUpperCase()} vk=${event.vk} scan=${event.scan} flags=${event.flags}`);
}, message => {
  console.error(message);
  void shutdown(1);
}, { suppressVk: 0, onReady() { console.log('Keyboard events (Ctrl+C exits). Hold Copilot and note its vk.'); } });

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await keyboard.stop();
  process.exitCode = code;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
