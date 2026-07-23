import { EventEmitter } from 'node:events';
import { AppState, ProviderId, Settings, UsageSnapshot } from '../shared/types';
import { debugLog } from './logger';
import { QuotaAxiClient } from './providers/quota-axi';

export interface SchedulerOptions {
  initialState: AppState;
  getSettings: () => Settings;
  persist: (state: AppState) => Promise<void>;
  client: QuotaAxiClient;
}

export class RefreshScheduler extends EventEmitter {
  private state: AppState;
  private readonly getSettings: () => Settings;
  private readonly persist: (state: AppState) => Promise<void>;
  private readonly client: QuotaAxiClient;
  private inFlight: Promise<AppState> | null = null;
  private inFlightForce = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(options: SchedulerOptions) {
    super();
    this.state = { ...options.initialState, refreshing: false };
    this.getSettings = options.getSettings;
    this.persist = options.persist;
    this.client = options.client;
  }

  getState(): AppState {
    return structuredClone(this.state);
  }

  start(): void {
    this.stopped = false;
    // The initial refresh schedules the recurring timer itself (via runRefresh
    // → scheduleNext), so there is no need to arm a second timer here.
    void this.refresh(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.client.stop();
  }

  settingsChanged(): void {
    this.scheduleNext();
  }

  refreshIfStale(maxAgeMs = 2 * 60_000): void {
    const now = Date.now();
    if ([this.state.claude, this.state.codex].some((snapshot) => !snapshot || now - snapshot.fetchedAt > maxAgeMs)) {
      void this.refresh(false);
    }
  }

  refresh(force: boolean): Promise<AppState> {
    if (this.inFlight) {
      // A forced (user-initiated) refresh must not be silently answered by an
      // in-flight background refresh: that background pass skips backed-off
      // providers and suppresses the Keychain prompt. Chain a forced run once
      // the current one settles so the force actually takes effect.
      if (force && !this.inFlightForce) return this.inFlight.then(() => this.refresh(true));
      return this.inFlight;
    }
    this.inFlightForce = force;
    this.inFlight = this.runRefresh(force).finally(() => {
      this.inFlight = null;
      this.inFlightForce = false;
    });
    return this.inFlight;
  }

  private async runRefresh(force: boolean): Promise<AppState> {
    this.state = { ...this.state, refreshing: true };
    this.emitChange();
    const now = Date.now();
    const providers = (['codex', 'claude'] as ProviderId[]).filter((provider) => {
      const retryAt = this.state[provider]?.error?.retryAt;
      return force || retryAt === undefined || retryAt <= now;
    });
    // QuotaAxiClient.fetch never rejects — it maps every failure to a snapshot
    // with an error field — so no try/catch is needed here. Providers filtered
    // out above are simply absent from `results` and preserved by mergeResult.
    // `force` doubles as the "may prompt for Keychain access" flag: only a
    // user-initiated refresh is allowed to surface a macOS Keychain prompt.
    const results = await this.client.fetch(providers, force);
    this.state = {
      claude: this.mergeResult('claude', results.claude),
      codex: this.mergeResult('codex', results.codex),
      refreshing: false,
    };
    this.emitChange();
    await this.persist(this.state).catch(() => debugLog('scheduler', 'Snapshot persistence failed.'));
    this.scheduleNext();
    return this.getState();
  }

  private mergeResult(provider: ProviderId, next: UsageSnapshot | undefined): UsageSnapshot | null {
    const previous = this.state[provider];
    if (!next) return previous;
    if (next.ok || !previous || previous.windows.length === 0) return next;
    return {
      ...next,
      fetchedAt: previous.fetchedAt,
      planType: previous.planType,
      windows: previous.windows,
      source: previous.source,
    };
  }

  private scheduleNext(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const minutes = Math.max(3, this.getSettings().pollIntervalMinutes);
    const jitter = 0.95 + Math.random() * 0.1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh(false);
    }, minutes * 60_000 * jitter);
  }

  private emitChange(): void {
    this.emit('changed', this.getState());
  }
}
