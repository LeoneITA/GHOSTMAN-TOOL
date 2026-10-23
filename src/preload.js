const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ghostman", {
  getPlugins: () => ipcRenderer.invoke("ghostman:get-plugins"),
  openPluginPage: (id) => ipcRenderer.invoke("ghostman:open-plugin-page", id),
  importCommunityPlugin: () =>
    ipcRenderer.invoke("ghostman:community-plugins:import"),
  installImportedCommunityPlugin: (id) =>
    ipcRenderer.invoke("ghostman:community-plugins:install-imported-folder", id),

  getCommunityFiles: () =>
    ipcRenderer.invoke("ghostman:community-files:list"),

  importCommunityFiles: () =>
    ipcRenderer.invoke("ghostman:community-files:import"),

  openCommunityFile: (id) =>
    ipcRenderer.invoke("ghostman:community-files:open", id),

  exportCommunityFile: (id) =>
    ipcRenderer.invoke("ghostman:community-files:export", id),

  removeCommunityFile: (id) =>
    ipcRenderer.invoke("ghostman:community-files:remove", id),

  setCommunityFileRemoteAccess: (id, allowed) =>
    ipcRenderer.invoke("ghostman:community-files:set-remote", {
      id,
      allowed,
    }),

  getAppVersion: () => ipcRenderer.invoke("ghostman:get-app-version"),

  getUpdateState: () => ipcRenderer.invoke("ghostman:get-update-state"),

  checkForUpdates: () => ipcRenderer.invoke("ghostman:check-for-updates"),

  installUpdate: () => ipcRenderer.invoke("ghostman:install-update"),

  downloadUpdateInstaller: () =>
    ipcRenderer.invoke("ghostman:download-update-installer"),

  onUpdateState: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on("ghostman:update-state", listener);
    return () => ipcRenderer.removeListener("ghostman:update-state", listener);
  },

  runPlugin: (id, input = {}) =>
    ipcRenderer.invoke("ghostman:run-plugin", { id, input }),

  setPluginRemoteApproval: (id, approved) =>
    ipcRenderer.invoke("ghostman:set-plugin-remote-approval", {
      id,
      approved,
    }),

  getRemoteStatus: () => ipcRenderer.invoke("ghostman:get-remote-status"),

  startRemoteAccess: () => ipcRenderer.invoke("ghostman:start-remote-access"),

  stopRemoteAccess: () => ipcRenderer.invoke("ghostman:stop-remote-access"),

  runTool: (id, input = {}) =>
    ipcRenderer.invoke("ghostman:run-tool", { id, input }),

  openExternal: (url) => ipcRenderer.invoke("ghostman:open-external", url),
});
