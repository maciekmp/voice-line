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
  ready() { ipcRenderer.send('voice:ready'); },
  open() { ipcRenderer.send('voice:open'); },
  hover(entered) { ipcRenderer.send('voice:hover', entered); },
  composerFocus(focused) { ipcRenderer.send('voice:composer-focus', focused); },
  text(text, imageId) { return ipcRenderer.invoke('voice:text', imageId === undefined ? text : { text, imageId }); },
  selectImage(id) { return ipcRenderer.invoke('voice:image-selection', id); },
  copyCode(text) { return ipcRenderer.invoke('voice:copy-code', text); },
  imagePreview(id) { return ipcRenderer.invoke('voice:image-preview', id); },
  saveImage(id) { return ipcRenderer.invoke('voice:image-save', id); },
  resize(size) { ipcRenderer.send('voice:resize', size); },
  command(command) { return ipcRenderer.invoke('voice:command', command); },
  onLevel(callback) { return listen('voice:level', callback); },
  onVoice(callback) { return listen('voice:snapshot', callback); },
  onClearDraft(callback) { return listen('voice:clear-draft', callback); },
  onMode(callback) { return listen('voice:mode', callback); },
  onPinned(callback) { return listen('voice:pinned', callback); },
  onResizing(callback) { return listen('voice:resizing', callback); },
  onVisible(callback) { return listen('voice:visible', callback); },
  onSettings(callback) { return listen('voice:visual-settings', callback); },
};
contextBridge.exposeInMainWorld('voiceDesktop', desktopApi);
