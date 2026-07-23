import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ExternalDestination, RendererApi, SettingsPatch } from '../shared/types';

// Keep the sandboxed preload self-contained: sandbox preloads cannot require
// arbitrary local CommonJS modules at runtime.
const IPC = {
  stateGet: 'state:get',
  stateRefresh: 'state:refresh',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  openExternal: 'app:openExternal',
  quit: 'app:quit',
  stateChanged: 'state:changed',
} as const;

const api: RendererApi = {
  getState: () => ipcRenderer.invoke(IPC.stateGet) as Promise<AppState>,
  refreshState: () => ipcRenderer.invoke(IPC.stateRefresh) as Promise<AppState>,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, patch),
  openExternal: (destination: ExternalDestination) => ipcRenderer.invoke(IPC.openExternal, destination),
  quit: () => ipcRenderer.send(IPC.quit),
  onStateChanged: (callback: (state: AppState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState): void => callback(state);
    ipcRenderer.on(IPC.stateChanged, listener);
    return () => ipcRenderer.removeListener(IPC.stateChanged, listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

declare global {
  interface Window {
    api: RendererApi;
  }
}
