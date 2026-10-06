const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbDesktop', {
  ready() { ipcRenderer.send('orb:ready'); },
  open() { ipcRenderer.send('voice:open'); },
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
