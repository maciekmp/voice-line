const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('imageDecoder', {
  onSource(callback) { ipcRenderer.once('image-decoder:source', (_event, source) => callback(source)); },
  result(value) { ipcRenderer.send('image-decoder:result', value); },
});
