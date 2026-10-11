const { contextBridge, ipcRenderer } = require('electron');

/** @template T @param {string} channel @param {(value: T) => void} callback */
function listen(channel, callback) {
  /** @param {Electron.IpcRendererEvent} _event @param {T} value */
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** @type {import('../src/desktop-contract.ts').DesktopApi} */
const desktopApi = {
  ready() { ipcRenderer.send('orb:ready'); },
  open() { ipcRenderer.send('voice:open'); },
  hover(entered) { ipcRenderer.send('voice:hover', entered); },
  composerFocus(focused) { ipcRenderer.send('voice:composer-focus', focused); },
  text(text) { return ipcRenderer.invoke('voice:text', text); },
  copyCode(text) { return ipcRenderer.invoke('voice:copy-code', text); },
  imagePreview(id) { return ipcRenderer.invoke('voice:image-preview', id); },
  saveImage(id) { return ipcRenderer.invoke('voice:image-save', id); },
  resize(size) { ipcRenderer.send('voice:resize', size); },
  command(command) { ipcRenderer.send('voice:command', command); },
  exitComplete() { ipcRenderer.send('orb:exit-complete'); },
  onLevel(callback) { return listen('orb:level', callback); },
  onVoice(callback) { return listen('voice:snapshot', callback); },
  onClearDraft(callback) { return listen('voice:clear-draft', callback); },
  onMode(callback) { return listen('voice:mode', callback); },
  onPinned(callback) { return listen('voice:pinned', callback); },
  onResizing(callback) { return listen('voice:resizing', callback); },
  onPresence(callback) { return listen('orb:presence', callback); },
  onSettings(callback) { return listen('orb:settings', callback); },
};
contextBridge.exposeInMainWorld('orbDesktop', desktopApi);
