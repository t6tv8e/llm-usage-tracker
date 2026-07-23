import { app, ipcMain, shell } from 'electron';
import { ExternalDestination, IPC } from '../shared/types';
import { RefreshScheduler } from './scheduler';
import { SettingsStore } from './settings';

const EXTERNAL_URLS: Record<ExternalDestination, string> = {
  'claude-usage': 'https://claude.ai/settings/usage',
  'codex-usage': 'https://chatgpt.com/codex/settings/usage',
};

function validateDestination(value: unknown): ExternalDestination {
  if (value === 'claude-usage' || value === 'codex-usage') return value;
  throw new Error('External destination is not allowed');
}

export function registerIpc(
  scheduler: RefreshScheduler,
  settings: SettingsStore,
  onSettingsChanged: () => void,
): void {
  ipcMain.handle(IPC.stateGet, () => scheduler.getState());
  ipcMain.handle(IPC.stateRefresh, () => scheduler.refresh(true));
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, async (_event, value: unknown) => {
    const next = await settings.update(value);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    scheduler.settingsChanged();
    onSettingsChanged();
    return next;
  });
  ipcMain.handle(IPC.openExternal, async (_event, value: unknown) => {
    const destination = validateDestination(value);
    await shell.openExternal(EXTERNAL_URLS[destination]);
  });
  ipcMain.on(IPC.quit, () => app.quit());
}
