const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('screenSelector', {
  onFrame(callback) { ipcRenderer.once('screen-capture:frame', (_event, frame) => callback(frame)); },
  select(value) { ipcRenderer.send('screen-capture:selection', value); },
});
