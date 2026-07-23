// These types are intentionally inlined rather than imported from
// shared/types.ts. This renderer is loaded as a classic <script> (no bundler),
// so the file must not become an ES module: any top-level `import`/`export` —
// even an erased `import type` — makes tsc emit `exports`/`__esModule`, which
// throws "exports is not defined" in the browser and breaks the whole page.
// Keep these mirrors in sync with shared/types.ts by hand.
type ProviderId = 'claude' | 'codex';
type TrayMode = 'icon' | 'both' | 'highest' | 'claude' | 'codex';
interface UsageWindow {
  kind: 'session' | 'weekly' | 'other';
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  windowMinutes: number | null;
}
interface UsageSnapshot {
  provider: ProviderId;
  ok: boolean;
  fetchedAt: number;
  planType: string | null;
  windows: UsageWindow[];
  error: { code: string; message: string; retryAt?: number } | null;
  source: 'quota-axi' | 'quota-axi-cache';
}
interface AppState {
  claude: UsageSnapshot | null;
  codex: UsageSnapshot | null;
  refreshing: boolean;
}
interface Settings {
  trayMode: TrayMode;
  pollIntervalMinutes: number;
  warnAtPercent: number;
  launchAtLogin: boolean;
}

const providersElement = required<HTMLElement>('providers');
const updatedElement = required<HTMLElement>('updated');
const refreshButton = required<HTMLButtonElement>('refresh');
const settingsButton = required<HTMLButtonElement>('settings-toggle');
const settingsPanel = required<HTMLElement>('settings-panel');
const settingsForm = required<HTMLFormElement>('settings-form');
const trayModeInput = required<HTMLSelectElement>('tray-mode');
const pollInput = required<HTMLInputElement>('poll-interval');
const warnInput = required<HTMLInputElement>('warn-threshold');
const launchInput = required<HTMLInputElement>('launch-login');
const settingsStatus = required<HTMLElement>('settings-status');

let state: AppState = { claude: null, codex: null, refreshing: false };
// Placeholder defaults, overwritten by getSettings() on startup. These mirror
// DEFAULT_SETTINGS in src/main/settings.ts; the value can't be imported here
// because this bundler-free renderer runs as a classic script (no runtime
// imports), so keep the two in sync if the defaults change.
let settings: Settings = {
  trayMode: 'icon',
  pollIntervalMinutes: 5,
  warnAtPercent: 80,
  launchAtLogin: false,
};

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function formatAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Bare "time until" phrase, e.g. "in 5m", "in 2h 03m", or "Mon 14:00" for
// timestamps more than a day out. Callers compose their own prefix so no one
// has to string-strip a fixed wording back off (see formatReset/renderMessage).
function humanizeUntil(timestamp: number, now: number): string {
  const remaining = timestamp - now;
  if (remaining <= 0) return 'now';
  if (remaining <= 24 * 60 * 60_000) {
    const totalMinutes = Math.max(1, Math.ceil(remaining / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `in ${hours}h ${String(minutes).padStart(2, '0')}m` : `in ${minutes}m`;
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function formatReset(timestamp: number, now = Date.now()): string {
  if (timestamp - now <= 0) return 'reset due';
  return `resets ${humanizeUntil(timestamp, now)}`;
}

function displayPlan(provider: ProviderId, plan: string | null): string {
  if (!plan) return '';
  const title = plan.replace(/[_-]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (provider === 'codex') return /^chatgpt/i.test(title) ? title : `ChatGPT ${title}`;
  return /plan$/i.test(title) ? title : `${title} plan`;
}

function renderWindow(window: UsageWindow): HTMLElement {
  const container = element('div', 'usage-window');
  const heading = element('div', 'usage-label-row');
  heading.append(element('span', 'window-label', window.label));
  heading.append(element('span', 'percent', `${Math.round(window.usedPercent)}%`));
  container.append(heading);

  const track = element('div', 'bar');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', `${window.label} usage`);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(window.usedPercent)));
  const critical = window.usedPercent >= 95;
  const warning = window.usedPercent >= settings.warnAtPercent;
  const fill = element('div', `bar-fill${critical ? ' crit' : warning ? ' warn' : ''}`);
  fill.style.width = `${Math.max(0, Math.min(100, window.usedPercent))}%`;
  track.append(fill);
  container.append(track);

  if (window.resetsAt !== null) {
    const reset = element('div', 'reset', formatReset(window.resetsAt));
    reset.title = new Date(window.resetsAt).toLocaleString();
    container.append(reset);
  }
  return container;
}

function renderMessage(snapshot: UsageSnapshot): HTMLElement | null {
  if (!snapshot.error) return null;
  let message = snapshot.error.message;
  if (snapshot.error.retryAt && snapshot.error.retryAt > Date.now()) {
    message += ` Retry ${humanizeUntil(snapshot.error.retryAt, Date.now())}.`;
  }
  const row = element('div', 'message-row');
  row.append(element('span', '', message));
  const action = element('button', '', 'View usage');
  action.type = 'button';
  action.addEventListener('click', () => {
    void window.api.openExternal(snapshot.provider === 'claude' ? 'claude-usage' : 'codex-usage');
  });
  row.append(action);
  return row;
}

function renderProvider(provider: ProviderId, snapshot: UsageSnapshot | null): HTMLElement {
  const card = element('article', 'provider-card');
  const heading = element('div', 'provider-heading');
  heading.append(element('h2', '', provider === 'codex' ? 'Codex' : 'Claude Code'));
  heading.append(element('span', 'plan', snapshot ? displayPlan(provider, snapshot.planType) : ''));
  card.append(heading);

  if (!snapshot) {
    card.append(element('div', 'empty', state.refreshing ? 'Loading…' : 'No data yet'));
    return card;
  }
  for (const usage of snapshot.windows) card.append(renderWindow(usage));
  if (snapshot.windows.length === 0 && !snapshot.error) card.append(element('div', 'empty', 'No usage windows'));

  if (snapshot.source === 'quota-axi-cache' && snapshot.windows.length > 0) {
    card.append(element('div', 'stale-row', `Cached quota, refreshed ${formatAge(snapshot.fetchedAt)}`));
  }
  const message = renderMessage(snapshot);
  if (message) card.append(message);
  return card;
}

function render(): void {
  providersElement.replaceChildren(
    renderProvider('codex', state.codex),
    renderProvider('claude', state.claude),
  );
  const timestamps = [state.codex?.fetchedAt, state.claude?.fetchedAt]
    .filter((value): value is number => typeof value === 'number');
  updatedElement.textContent = timestamps.length ? `Updated ${formatAge(Math.max(...timestamps))}` : 'Not updated yet';
  refreshButton.classList.toggle('spinning', state.refreshing);
  refreshButton.disabled = state.refreshing;
}

function populateSettings(): void {
  trayModeInput.value = settings.trayMode;
  pollInput.value = String(settings.pollIntervalMinutes);
  warnInput.value = String(settings.warnAtPercent);
  launchInput.checked = settings.launchAtLogin;
}

refreshButton.addEventListener('click', async () => {
  try {
    state = await window.api.refreshState();
    render();
  } catch {
    settingsStatus.textContent = 'Refresh failed';
  }
});

settingsButton.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
  providersElement.hidden = !settingsPanel.hidden;
  settingsStatus.textContent = '';
  if (!settingsPanel.hidden) populateSettings();
});

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  settingsStatus.textContent = 'Saving…';
  try {
    settings = await window.api.setSettings({
      trayMode: trayModeInput.value as Settings['trayMode'],
      pollIntervalMinutes: Number(pollInput.value),
      warnAtPercent: Number(warnInput.value),
      launchAtLogin: launchInput.checked,
    });
    settingsStatus.textContent = 'Saved';
    render();
  } catch {
    settingsStatus.textContent = 'Invalid settings';
  }
});

required<HTMLButtonElement>('quit').addEventListener('click', () => window.api.quit());
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!settingsPanel.hidden) {
    settingsPanel.hidden = true;
    providersElement.hidden = false;
  } else {
    window.blur();
  }
});

window.api.onStateChanged((nextState) => {
  state = nextState;
  render();
});

setInterval(render, 30_000);
void Promise.all([window.api.getState(), window.api.getSettings()]).then(([initialState, initialSettings]) => {
  state = initialState;
  settings = initialSettings;
  populateSettings();
  render();
}).catch(() => {
  providersElement.replaceChildren(element('div', 'empty', 'The app could not be initialized.'));
});
