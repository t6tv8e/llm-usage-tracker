import { app, nativeImage, powerMonitor, session } from 'electron';
import { menubar, Menubar } from 'menubar';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IPC } from '../shared/types';
import { registerIpc } from './ipc';
import { QuotaAxiClient } from './providers/quota-axi';
import { RefreshScheduler } from './scheduler';
import { SettingsStore } from './settings';
import { computeTrayPresentation } from './tray-title';

app.setName('LLM Usage');
const hasLock = app.requestSingleInstanceLock();
let activeMenubar: Menubar | null = null;

if (!hasLock) {
  app.quit();
} else {
  void app.whenReady().then(bootstrap).catch(() => {
    // Deliberately avoid logging provider data or account details.
    console.error('LLM Usage failed to initialize.');
    app.quit();
  });
}

async function bootstrap(): Promise<void> {
  const root = app.getAppPath();
  const store = new SettingsStore(app.getPath('userData'));
  await store.load();
  const cachedState = await store.loadSnapshots();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.get().launchAtLogin });

  const scheduler = new RefreshScheduler({
    initialState: cachedState,
    getSettings: () => store.get(),
    persist: (state) => store.saveSnapshots(state),
    client: new QuotaAxiClient(),
  });

  const normalImage = nativeImage.createFromPath(join(root, 'assets', 'IconTemplate.png'));
  normalImage.setTemplateImage(true);
  const criticalImage = nativeImage.createFromPath(join(root, 'assets', 'IconCritical.png'));
  const mb = menubar({
    index: pathToFileURL(join(root, 'src', 'renderer', 'index.html')).toString(),
    icon: normalImage,
    tooltip: 'LLM Usage',
    preloadWindow: true,
    showDockIcon: false,
    activateWithApp: false,
    browserWindow: {
      width: 340,
      height: 480,
      resizable: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      backgroundColor: '#202124',
      webPreferences: {
        preload: join(root, 'dist', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  });
  // Electron tray objects must remain strongly referenced for the lifetime of
  // the app or macOS may remove their status item after garbage collection.
  activeMenubar = mb;

  let trayReady = false;
  const updateTray = (): void => {
    if (!trayReady) return;
    const presentation = computeTrayPresentation(scheduler.getState(), store.get());
    mb.tray.setImage(presentation.critical ? criticalImage : normalImage);
    mb.tray.setTitle(presentation.title, { fontType: 'monospacedDigit' });
  };

  registerIpc(scheduler, store, updateTray);
  secureWindowWhenCreated(mb);

  scheduler.on('changed', (state) => {
    updateTray();
    const window = mb.window;
    if (window && !window.isDestroyed()) window.webContents.send(IPC.stateChanged, state);
  });

  mb.on('ready', () => {
    trayReady = true;
    updateTray();
    scheduler.start();
  });
  mb.on('show', () => scheduler.refreshIfStale());

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  powerMonitor.on('resume', () => {
    setTimeout(() => void scheduler.refresh(false), 5_000);
  });
  app.on('second-instance', () => void mb.showWindow());
  app.on('before-quit', () => {
    scheduler.stop();
    activeMenubar = null;
  });
}

function secureWindowWhenCreated(mb: Menubar): void {
  mb.on('before-load', () => {
    const window = mb.window;
    if (!window) return;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        mb.hideWindow();
      }
    });
  });
}
