import { startKeyboard } from '../src/keyboard/copilot-key.ts';

// Test an abrupt owner exit without invoking application services or Copilot.
const keyboard = startKeyboard(() => {}, message => {
  process.send?.({ type: 'error', message });
  process.exit(1);
}, { suppressVk: 135, onReady() { process.send?.({ type: 'ready', bridgePid: keyboard.pid }); } });
process.on('disconnect', () => process.exit(0));
