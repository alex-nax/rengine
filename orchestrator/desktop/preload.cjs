const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rengine', {
  chooseProject: () => ipcRenderer.invoke('choose-project'),
  onPrepareClose: callback => { ipcRenderer.on('prepare-close', callback); return () => ipcRenderer.removeListener('prepare-close', callback); },
  finishClose: () => ipcRenderer.send('finish-close'),
  cancelClose: message => ipcRenderer.send('cancel-close', String(message)),
});
