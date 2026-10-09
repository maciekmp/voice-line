const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbDesktop', {
  ready() { ipcRenderer.send('orb:ready'); },
  onLevel(callback) {
    const listener = (_event, level) => callback(level);
    ipcRenderer.on('orb:level', listener);
    return () => ipcRenderer.removeListener('orb:level', listener);
  },
  open() { ipcRenderer.send('voice:open'); },
  hover(entered) { ipcRenderer.send('voice:hover', entered); },
  text(text) { return ipcRenderer.invoke('voice:text', text); },
  copyCode(text) { return ipcRenderer.invoke('voice:copy-code', text); },
  imagePreview(id) { return ipcRenderer.invoke('voice:image-preview', id); },
  saveImage(id) { return ipcRenderer.invoke('voice:image-save', id); },
  resize(size) { ipcRenderer.send('voice:resize', size); },
  onResizing(callback) {
    const listener = (_event, resizing) => callback(resizing);
    ipcRenderer.on('voice:resizing', listener);
    return () => ipcRenderer.removeListener('voice:resizing', listener);
  },
  onMode(callback) {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('voice:mode', listener);
    return () => ipcRenderer.removeListener('voice:mode', listener);
  },
  onPinned(callback) {
    const listener = (_event, pinned) => callback(pinned);
    ipcRenderer.on('voice:pinned', listener);
    return () => ipcRenderer.removeListener('voice:pinned', listener);
  },
  command(command) { ipcRenderer.send('voice:command', command); },
  onVoice(callback) {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('voice:snapshot', listener);
    return () => ipcRenderer.removeListener('voice:snapshot', listener);
  },
  exitComplete() { ipcRenderer.send('orb:exit-complete'); },
  onPresence(callback) {
    const listener = (_event, presence) => callback(presence);
    ipcRenderer.on('orb:presence', listener);
    return () => ipcRenderer.removeListener('orb:presence', listener);
  },
  onSettings(callback) {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('orb:settings', listener);
    return () => ipcRenderer.removeListener('orb:settings', listener);
  },
});
