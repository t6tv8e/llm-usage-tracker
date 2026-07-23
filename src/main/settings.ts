import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppState, Settings, SettingsPatch, TrayMode, UsageSnapshot } from '../shared/types';
import { debugLog } from './logger';
import { asRecord } from './providers/common';

export const DEFAULT_SETTINGS: Settings = {
  trayMode: 'icon',
  pollIntervalMinutes: 5,
  warnAtPercent: 80,
  launchAtLogin: false,
};

const TRAY_MODES = new Set<TrayMode>(['icon', 'both', 'highest', 'claude', 'codex']);
const SETTING_KEYS = new Set<keyof Settings>([
  'trayMode',
  'pollIntervalMinutes',
  'warnAtPercent',
  'launchAtLogin',
]);

function isSnapshot(value: unknown, provider: 'claude' | 'codex'): value is UsageSnapshot {
  const record = asRecord(value);
  if (!record || record.provider !== provider || typeof record.ok !== 'boolean' || typeof record.fetchedAt !== 'number') return false;
  if (record.source !== 'quota-axi' && record.source !== 'quota-axi-cache') return false;
  if (!Array.isArray(record.windows) || !record.windows.every((item) => {
    const window = asRecord(item);
    return window
      && ['session', 'weekly', 'other'].includes(String(window.kind))
      && typeof window.label === 'string'
      && typeof window.usedPercent === 'number'
      && (window.resetsAt === null || typeof window.resetsAt === 'number')
      && (window.windowMinutes === null || typeof window.windowMinutes === 'number');
  })) return false;
  return record.error === null || asRecord(record.error) !== null;
}

export function validateSettingsPatch(value: unknown): SettingsPatch {
  const record = asRecord(value);
  if (!record) throw new Error('Settings update must be an object');
  for (const key of Object.keys(record)) {
    if (!SETTING_KEYS.has(key as keyof Settings)) throw new Error(`Unknown setting: ${key}`);
  }
  const patch: SettingsPatch = {};
  if ('trayMode' in record) {
    if (typeof record.trayMode !== 'string' || !TRAY_MODES.has(record.trayMode as TrayMode)) throw new Error('Invalid tray mode');
    patch.trayMode = record.trayMode as TrayMode;
  }
  if ('pollIntervalMinutes' in record) {
    if (typeof record.pollIntervalMinutes !== 'number' || !Number.isFinite(record.pollIntervalMinutes)
      || record.pollIntervalMinutes < 3 || record.pollIntervalMinutes > 1_440) {
      throw new Error('Poll interval must be between 3 and 1440 minutes');
    }
    patch.pollIntervalMinutes = Math.round(record.pollIntervalMinutes);
  }
  if ('warnAtPercent' in record) {
    if (typeof record.warnAtPercent !== 'number' || !Number.isFinite(record.warnAtPercent)
      || record.warnAtPercent < 1 || record.warnAtPercent >= 95) {
      throw new Error('Warning threshold must be between 1 and 94 percent');
    }
    patch.warnAtPercent = Math.round(record.warnAtPercent);
  }
  if ('launchAtLogin' in record) {
    if (typeof record.launchAtLogin !== 'boolean') throw new Error('Launch-at-login must be a boolean');
    patch.launchAtLogin = record.launchAtLogin;
  }
  return patch;
}

// Lenient counterpart to validateSettingsPatch for reading persisted settings:
// unknown keys are dropped and individually invalid values are skipped (falling
// back to the default for that key) instead of discarding the whole file. This
// keeps a user's other saved settings intact across schema changes.
export function coercePersistedSettings(value: unknown): SettingsPatch {
  const record = asRecord(value);
  if (!record) return {};
  const patch: SettingsPatch = {};
  for (const key of SETTING_KEYS) {
    if (!(key in record)) continue;
    try {
      Object.assign(patch, validateSettingsPatch({ [key]: record[key] }));
    } catch {
      debugLog('settings', `Ignoring invalid persisted value for "${key}".`);
    }
  }
  return patch;
}

export class SettingsStore {
  private readonly settingsPath: string;
  private readonly snapshotsPath: string;
  private settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(userDataPath: string) {
    this.settingsPath = join(userDataPath, 'settings.json');
    this.snapshotsPath = join(userDataPath, 'snapshots.json');
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown;
      this.settings = { ...DEFAULT_SETTINGS, ...coercePersistedSettings(parsed) };
    } catch {
      debugLog('settings', 'Could not read settings file; using defaults.');
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  get(): Settings {
    return { ...this.settings };
  }

  async update(value: unknown): Promise<Settings> {
    const patch = validateSettingsPatch(value);
    this.settings = { ...this.settings, ...patch };
    await this.atomicWrite(this.settingsPath, this.settings);
    return this.get();
  }

  async loadSnapshots(): Promise<AppState> {
    try {
      const parsed = asRecord(JSON.parse(await readFile(this.snapshotsPath, 'utf8')));
      return {
        claude: isSnapshot(parsed?.claude, 'claude') ? parsed.claude : null,
        codex: isSnapshot(parsed?.codex, 'codex') ? parsed.codex : null,
        refreshing: false,
      };
    } catch {
      debugLog('settings', 'Could not read persisted snapshots; starting empty.');
      return { claude: null, codex: null, refreshing: false };
    }
  }

  async saveSnapshots(state: AppState): Promise<void> {
    await this.atomicWrite(this.snapshotsPath, { claude: state.claude, codex: state.codex });
  }

  private async atomicWrite(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  }
}
