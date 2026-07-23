export type ProviderId = 'claude' | 'codex';

export type UsageWindowKind = 'session' | 'weekly' | 'other';

export interface UsageWindow {
  kind: UsageWindowKind;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
}

export type UsageErrorCode =
  | 'token-expired'
  | 'logged-out'
  | 'keychain-denied'
  | 'rate-limited'
  | 'network'
  | 'no-data'
  | 'parse'
  | 'cli-missing';

export interface UsageError {
  code: UsageErrorCode;
  message: string;
  retryAt?: number;
}

export interface UsageSnapshot {
  provider: ProviderId;
  ok: boolean;
  fetchedAt: number;
  planType: string | null;
  windows: UsageWindow[];
  error: UsageError | null;
  source: 'quota-axi' | 'quota-axi-cache';
}

export type TrayMode = 'icon' | 'both' | 'highest' | 'claude' | 'codex';

export interface Settings {
  trayMode: TrayMode;
  pollIntervalMinutes: number;
  warnAtPercent: number;
  launchAtLogin: boolean;
}

export interface AppState {
  claude: UsageSnapshot | null;
  codex: UsageSnapshot | null;
  refreshing: boolean;
}

export type SettingsPatch = Partial<Settings>;
export type ExternalDestination = 'claude-usage' | 'codex-usage';

export interface RendererApi {
  getState(): Promise<AppState>;
  refreshState(): Promise<AppState>;
  getSettings(): Promise<Settings>;
  setSettings(patch: SettingsPatch): Promise<Settings>;
  openExternal(destination: ExternalDestination): Promise<void>;
  quit(): void;
  onStateChanged(callback: (state: AppState) => void): () => void;
}

export const IPC = {
  stateGet: 'state:get',
  stateRefresh: 'state:refresh',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  openExternal: 'app:openExternal',
  quit: 'app:quit',
  stateChanged: 'state:changed',
} as const;
