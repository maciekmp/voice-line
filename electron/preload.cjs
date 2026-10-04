const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbDesktop', {
  ready() { ipcRenderer.send('orb:ready'); },
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
