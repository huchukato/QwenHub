const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  capabilities: () => ipcRenderer.invoke('capabilities'),
  loadFile: (filePath) => ipcRenderer.invoke('loadFile', filePath),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('saveSettings', settings),
});
