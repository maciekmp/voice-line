// Native smoke tests need an IPC receipt before evaluating renderer state.
async function synchronizeRenderer(webContents, { timeoutMs = 3000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid renderer synchronization timeout');
  const originalSend = webContents.send;
  const originalExecute = webContents.executeJavaScript;
  const key = '__voiceLineSmokeReceipts';
  const cleanupPage = `window.${key}?.dispose(); delete window.${key}; void 0;`;
  try {
    await originalExecute.call(webContents, `(() => {
      const receipts = new Set(), waiters = new Set(), unsubscribe = [];
      let watermark = 0;
      const receive = value => {
        const id = value?.__smokeReceipt;
        if (!Number.isSafeInteger(id) || id < 1) return;
        receipts.add(id);
        while (receipts.delete(watermark + 1)) watermark++;
        for (const waiter of waiters) {
          if (waiter.target > watermark) continue;
          clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve();
        }
      };
      window.${key} = {
        wait(target, timeout) {
          if (watermark >= target) return Promise.resolve();
          return new Promise((resolve, reject) => {
            const waiter = { target, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error('Timed out waiting for renderer IPC receipt ' + target + ' (received ' + watermark + ')'));
            }, timeout);
            waiters.add(waiter);
          });
        },
        dispose() {
          for (const stop of unsubscribe) stop();
          for (const waiter of waiters) {
            clearTimeout(waiter.timer); waiter.reject(new Error('Renderer synchronization disposed'));
          }
          waiters.clear();
        },
      };
      unsubscribe.push(window.voiceDesktop.onVoice(receive));
      unsubscribe.push(window.voiceDesktop.onSettings(receive));
    })()`);
  } catch (error) {
    await originalExecute.call(webContents, cleanupPage).catch(() => {});
    throw error;
  }
  let sequence = 0;
  webContents.send = function (...args) {
    const [channel, value] = args;
    if (['voice:snapshot', 'voice:visual-settings'].includes(channel) && value && typeof value === 'object' && !Array.isArray(value)) {
      args[1] = { ...value, __smokeReceipt: ++sequence };
    }
    return originalSend.apply(this, args);
  };
  webContents.executeJavaScript = async function (...args) {
    await originalExecute.call(this, `window.${key}.wait(${sequence}, ${timeoutMs})`);
    return originalExecute.apply(this, args);
  };
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    webContents.send = originalSend;
    webContents.executeJavaScript = originalExecute;
    if (!webContents.isDestroyed?.()) await originalExecute.call(webContents, cleanupPage);
  };
}

module.exports = { synchronizeRenderer };
