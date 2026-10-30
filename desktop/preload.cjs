const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('smartStore', Object.freeze({
  isDesktop: true,
  exportProject: (payload) => ipcRenderer.invoke('generator:export', payload),
  pickMaterials: () => ipcRenderer.invoke('generator:pick-materials'),
  openPath: (target) => ipcRenderer.invoke('generator:open-path', target),
  saveImage: (payload) => ipcRenderer.invoke('generator:save-image', payload),
}));
