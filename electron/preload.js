const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  chat: (payload) => ipcRenderer.invoke('chat', payload),
  capabilities: () => ipcRenderer.invoke('capabilities'),
  loadFile: (filePath) => ipcRenderer.invoke('loadFile', filePath),
  loadMediaUrl: (url) => ipcRenderer.invoke('loadMediaUrl', url),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  saveSettings: (settings) => ipcRenderer.invoke('saveSettings', settings),
  deleteOutput: (url) => ipcRenderer.invoke('deleteOutput', url),
  saveOutput: (url) => ipcRenderer.invoke('saveOutput', url),
});
