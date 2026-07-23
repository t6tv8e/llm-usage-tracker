# Plan: llm-usage-tracker — macOS menu bar usage quota app

_Merged plan of record (best of `plan.md` + the original `plan2.md`). Supersedes `plan.md`._

## Context

Personal, **local-only** macOS menu bar app (never distributed — no signing/notarization/auto-update, may hardcode this machine's setup). Clicking the tray icon opens a popover showing current **subscription quota usage** for:

- **OpenAI Codex** (ChatGPT plan): 5-hour + weekly windows, as shown by `/status`.
- **Claude Code** (Anthropic Pro/Max): 5-hour + weekly (+ Opus weekly) windows, as shown by `/usage`.

Decisions already made with the user: **Electron + `menubar` package + TypeScript**; Claude data via the OAuth usage endpoint; tray title display **configurable** (icon only / both % / highest % / Claude only / Codex only).

Versions verified on this machine: Codex CLI `0.145.0`, Claude Code `2.1.218`, Node `24.x`.

## Stack & tooling (from plan2 — lean wins for a personal tool)

Plain **`tsc`, CommonJS, no bundler, no Forge/Vite, no React** — 3 tiny entry points, no HMR or packaging pipeline needed. Node ≥18 global `fetch`, no HTTP dep.

- Deps: `menubar` (^9) — tray + popover positioning + hide-on-blur out of the box (replaces plan.md's hand-rolled tray/popover controllers).
- Dev: `electron` (^37), `typescript`, `@types/node`.
- Settings: hand-rolled JSON file in `app.getPath('userData')` (electron-store v10+ is ESM-only; ~30 lines by hand).
- No Zod: parse with try/catch → typed error states; keep **sanitized response fixtures** (from plan.md) in `tests/fixtures/` so parsers can be re-checked when CLIs update. A couple of plain node:test unit tests for the two parsers — optional but cheap.

```
package.json                 "main": "dist/main/index.js"; scripts: build=tsc, start, watch
tsconfig.json                commonjs, strict, lib ES2022+DOM, outDir dist
assets/IconTemplate.png(+@2x)  16pt monochrome; "Template" suffix = auto dark/light
src/
  shared/types.ts            UsageSnapshot, Settings, IPC contract
  main/
    index.ts                 menubar() bootstrap, single-instance lock, dock hide
    tray-title.ts            title computation per TrayMode
    scheduler.ts             poll loop, backoff gates, powerMonitor resume
    settings.ts              JSON persistence
    ipc.ts                   ipcMain handlers (validate every payload)
    providers/
      claude.ts              keychain + oauth/usage fetch + auth-status
      codex.ts               app-server JSON-RPC client + jsonl fallback
  preload/preload.ts         contextBridge → window.api
  renderer/
    index.html               stays in src/, <script> → ../../dist/renderer/renderer.js (no copy step)
    styles.css               dark mode via prefers-color-scheme
    renderer.ts              render(state), 30s countdown re-render
scripts/probe.ts             Phase-0 spike: prints both snapshots without Electron
tests/fixtures/              sanitized provider responses per CLI version
```

## Shared contract (`src/shared/types.ts`)

```ts
type ProviderId = 'claude' | 'codex';
interface UsageWindow { kind: 'session'|'weekly'|'other'; label: string;   // "5h", "Weekly", "Weekly (Opus)"
  usedPercent: number;             // normalized 0–100, clamped
  resetsAt: number|null;           // epoch ms (normalize ISO strings AND unix seconds)
  windowMinutes: number|null; }
interface UsageSnapshot { provider: ProviderId; ok: boolean;
  fetchedAt: number;               // for codex-jsonl fallback: timestamp of the line (staleness!)
  planType: string|null; windows: UsageWindow[];   // render as a LIST — never assume exactly 2 bars
  error: { code:'token-expired'|'logged-out'|'keychain-denied'|'rate-limited'
              |'network'|'no-data'|'parse'|'cli-missing';
           message: string; retryAt?: number } | null; }
type TrayMode = 'icon'|'both'|'highest'|'claude'|'codex';
interface Settings { trayMode: TrayMode; pollIntervalMinutes: number;  // default 5, floor 3
  warnAtPercent: number;           // default 80 (95 = critical stays fixed)
  launchAtLogin: boolean; }
interface AppState { claude: UsageSnapshot|null; codex: UsageSnapshot|null; }
```

IPC (narrow, validated; renderer never sees tokens or raw responses): `state:get`, `state:refresh`, `settings:get`, `settings:set`, `app:openExternal` (allowlisted vendor URLs only), `app:quit`; push `state:changed`. Preload exposes `window.api` via `contextBridge`; `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP meta tag, deny navigation/window-open.

## Provider: Codex (merged — best of both)

**Primary: `codex app-server` JSON-RPC over stdio** (from plan.md — live data, Codex owns auth/token refresh, no reading `auth.json`):

1. Resolve the `codex` binary (check `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, PATH); `codex --version` gate.
2. Spawn `codex app-server` (stdio, `shell: false`, absolute path), send `initialize`, then `account/rateLimits/read`.
3. Parse newline-delimited JSON-RPC; prefer `rateLimitsByLimitId`, fall back to legacy `rateLimits`. Normalize `usedPercent` / `windowDurationMins` / `resetsAt` + plan + credits.
4. Keep the process alive for the app's lifetime; restart once on unexpected exit; kill on quit. Use `codex app-server generate-ts` output as a dev-time reference for the protocol shape.

**Fallback: session-file parsing** (from plan2 — verified against real data on this machine, ~40 lines, zero processes). If the app-server spike fails or the experimental command changes: newest `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (check ~5 newest files), scan lines in reverse for `type === 'event_msg'` with `payload.rate_limits`. **Critical verified quirk: classify windows by `window_minutes`** (~300 → 5h, ~10080 → weekly) — on this machine the weekly window sits in `primary` and `secondary` is `null`. `resets_at` is unix seconds. Data is stale-by-design → always show its age.

The Phase-0 probe script tries the app-server first and prints which path works; the fallback ships regardless (it's nearly free).

## Provider: Claude Code

1. **Login state** via `claude auth status --json` (verified working: `loggedIn`, `authMethod`, `email`, plan info) → drives `logged-out` state with "run `claude` to log in" message. No token exposure.
2. **Quota** via `GET https://api.anthropic.com/api/oauth/usage`:
   - Token from macOS Keychain: `security find-generic-password -s "Claude Code-credentials" -a $USER -w` → JSON `claudeAiOauth.{accessToken, refreshToken, expiresAt}`. First read triggers one Keychain dialog → **Always Allow**. Cache in memory; re-read only on startup, 401, or past `expiresAt`. Deny → `keychain-denied`, no retry loop.
   - Headers: `Authorization: Bearer …`, **`User-Agent: claude-code/<version>`** (required — else instant 429; version from `claude --version`, hardcoded fallback `2.1.218`), `anthropic-beta: oauth-2025-04-20`.
   - Parse `five_hour` / `seven_day` and tolerate model-scoped extras (`seven_day_opus`, `seven_day_sonnet`) as additional windows. Normalize utilization to 0–100 and both timestamp formats.
   - **429**: honor `Retry-After`, else exponential backoff 5→10→20→40 min; keep serving the last good snapshot; never poll < 3 min.
   - **Token expiry — v1 does NOT run the OAuth refresh flow** (rotating the refresh token without atomically writing it back to the Keychain risks logging Claude Code out; deferred to v1.5). Show "Open Claude Code to refresh login"; re-read the Keychain each poll so it self-heals. Never a 401 retry loop.
3. **Fallback if the spike fails** (from plan.md): show auth status + an "Open claude.ai usage page" button; never scrape or ask for pasted tokens.

## Refresh & caching policy (merged)

- Fetch both providers concurrently at launch; failures are isolated per provider.
- Background poll every `pollIntervalMinutes` (default 5) with small random jitter; per-provider `retryAt` backoff gates.
- Refresh on popover open if data > 2 min old; manual ↻ always available, deduped with in-flight runs.
- 5 s timeout per network/process attempt; at most one retry for transient failures; never retry 401.
- `powerMonitor.on('resume')` → refresh after 5 s; renderer recomputes countdowns every 30 s so they never go negative after sleep.
- Keep last good snapshot in memory; optionally persist normalized snapshots (never raw responses/tokens) so the popover has data instantly on restart.

## Tray title

`mb.tray.setTitle(text, { fontType: 'monospacedDigit' })` (no menu-bar width jiggle). Per service show the **worst** window:

- `icon` → `''` · `both` → `C 42% · X 7%` · `highest` → `X 87%` · `claude`/`codex` → single service.
- Failed provider → `–` (e.g. `C –% · X 7%`). `setTitle` can't be colored: append `⚠` at ≥ `warnAtPercent`, swap to a red non-template icon (`tray.setImage`) at ≥ 95%.

## Popover UI (plain TS, no framework)

```
LLM Usage                              ↻ ⚙
Codex                          ChatGPT Plus
  5-hour   [████████░░░░]  42%  resets in 2h 18m
  Weekly   [█████████░░░]  67%  resets Thu 09:00
Claude Code                        Max plan
  5-hour   [████░░░░░░░░]  31%  resets in 1h 02m
  Weekly   [███████░░░░░]  58%
  Weekly (Opus) [████████▌░]  72%
Updated 2m ago            Settings · Quit
```

Cards render the window **list** (not a fixed pair). Bars get `.warn`/`.crit` classes at thresholds. Error states render as an actionable message row (logged-out → login hint; no-data → "run codex once"; stale codex-jsonl → "data from last codex run, Xh ago"). Inline settings panel: trayMode select, poll interval, warn threshold, launch-at-login. Escape/blur hides (menubar handles blur). Exact reset datetime as a tooltip.

## macOS details

- `app.requestSingleInstanceLock()` (no duplicate tray icons); `app.dock.hide()`; retain tray reference; create after `app.whenReady()`.
- `browserWindow: { width: 340, height: 480, resizable: false }` via menubar options.
- Redact all auth material and account identifiers from logs.
- **Launch at login**: `app.setLoginItemSettings` only works packaged — toggle applies only `if (app.isPackaged)`, else shows "(requires packaged build)". One-shot packaging: `npx @electron/packager . "LLM Usage" --platform=darwin --arch=arm64 --out=out` → copy to /Applications (unsigned OK locally; also stabilizes the Keychain "Always Allow" grant). Set `LSUIElement` in the packaged plist.

## Implementation order & verification

1. **Phase 0 — provider spike, no Electron** (~1 h): `scripts/probe.ts` exercises both providers and prints `UsageSnapshot`s. Decides Codex path (app-server vs jsonl fallback), proves Keychain read + endpoint headers. Save sanitized fixtures. Hit the Claude endpoint sparingly. **Gate:** if Claude access can't be done safely, ship Codex-only + Claude auth-status fallback.
2. **Electron shell** (~30 min): tray icon, popover toggles, no Dock icon, single instance.
3. **IPC + scheduler** (~45 min): live numbers in popover; confirm re-polls + backoff logs over 10 min.
4. **Renderer UI** (~45 min): cards, bars, countdown tick, refresh, error rows.
5. **Tray modes + settings** (~30 min): cycle all 5 modes; restart → settings survive; fake 95% → warning states.
6. **Edge-case pass** (~30 min): rename `~/.codex/sessions` → no-data; bogus Keychain service → keychain-denied; network off → network state; sleep/wake → refresh + sane countdowns; `claude auth status` logged-out path.
7. **Optional**: package, /Applications, launch-at-login, log out/in.

Realistic scope: **~1 day** (the app-server JSON-RPC client is the main addition over the original 3–4 h estimate).

## Risks

- Claude `oauth/usage` endpoint and `codex app-server` are both private/experimental — shapes can change. Mitigation: all protocol handling isolated in the two provider files, try/catch → `parse` error state (never crash), fixtures to re-verify after CLI updates. Accepted for a personal tool.
- Keychain prompt/ACL quirks — mitigated by in-memory caching (one read per run happy-path) and packaging.
- Codex jsonl fallback is stale-by-design — surfaced as data age in UI.

## Later (explicitly not v1)

Claude OAuth token refresh with atomic Keychain write-back; live `wham/usage` Codex endpoint; threshold notifications; usage-history sparklines; additional providers behind the same `UsageSnapshot` interface.
