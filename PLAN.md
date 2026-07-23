# macOS LLM Usage Tracker — Implementation Plan

_Planned on 2026-07-23_

## 1. Goal and assumptions

Build a macOS menu-bar-only application that shows the remaining subscription quota for:

- **OpenAI Codex** (ChatGPT/Codex subscription usage, not OpenAI API billing)
- **Anthropic Claude Code** (Claude subscription usage, not Anthropic API billing)

I assume “OpenAI codecs” means **Codex** and “Cloud Code” means **Claude Code**. If “Cloud Code” means Google's Cloud Code product, that provider needs a different design.

### Local-only scope constraint

This application is **permanently local and personal**. It will run only on my own Mac and is not intended to be shipped, published, sold, or installed by other users. The implementation may therefore target this machine's architecture, installed CLI versions, account setup, and Keychain configuration.

It should reuse the accounts already authenticated in each vendor's CLI rather than asking for pasted tokens. Public distribution work—onboarding arbitrary users, broad compatibility, analytics, auto-update infrastructure, Developer ID signing, notarization, DMGs, and release management—is explicitly out of scope.

## 2. Recommendation

Use **Electron + TypeScript + React** for the first version.

Electron is the best fit here because:

- It stays almost entirely in the JavaScript ecosystem.
- Electron has first-class `Tray`, `BrowserWindow`, Dock-hiding, and macOS packaging APIs.
- Node can launch the Codex and Claude CLIs and communicate with Codex's JSON-RPC app server.
- The UI is small enough that Electron's main drawback—application size and memory—is acceptable for an MVP.

### Proposed stack

| Area | Choice |
|---|---|
| Runtime | Electron, pinned to a current stable version |
| Language | TypeScript with strict mode |
| UI | React + Vite + plain CSS/CSS modules |
| Scaffolding/build | Electron Forge with its Vite template |
| Runtime validation | Zod for vendor responses and IPC payloads |
| Unit tests | Vitest |
| UI tests | React Testing Library |
| Packaged-app smoke tests | Playwright plus a small manual macOS checklist |
| Lint/format | ESLint + Prettier |
| Installation | Local development/package build for this Mac only; no public installer |

Avoid a large state-management or design-system dependency. The renderer only needs a snapshot, loading state, errors, and settings.

## 3. Alternatives considered

### Tauri 2

**Advantages:** much smaller binary and lower idle memory.

**Disadvantages:** provider/process integration and macOS window behavior move part of the project into Rust. It is a good second choice, but it weakens the JavaScript-first preference and will take longer to prototype.

### Native SwiftUI with `MenuBarExtra`

**Advantages:** best macOS feel, smallest footprint, and direct Keychain integration.

**Disadvantages:** most of the application would be Swift, while the Codex protocol and response normalization are convenient in TypeScript.

### Decision

Start with Electron. Revisit Tauri or Swift only if measured idle memory or popover behavior is unacceptable after the MVP.

## 4. User experience

### Menu bar

- A monochrome macOS template icon.
- Optional compact title showing the most constrained quota, such as `38% left`.
- Normal state, warning state, stale/error state, and refreshing state.
- The app does not appear in the Dock or normal app switcher.

### Popover

Clicking the tray icon opens a small window positioned under the icon. It contains:

```text
LLM Usage                              ↻

Codex                         ChatGPT Plus
5-hour limit                 42% used
[████████░░░░░░░░░░░]        resets in 2h 18m
Weekly limit                 67% used
[█████████████░░░░░░]

Claude Code                     Max plan
5-hour limit                 31% used
Weekly limit                 58% used
Opus weekly                  72% used

Updated 2 minutes ago
Settings                              Quit
```

Behavior:

- Hide when it loses focus, when Escape is pressed, or when the tray icon is clicked again.
- Refresh on opening if the cached data is stale.
- Show the last successful value while a refresh is in progress.
- Show useful provider-specific states: CLI not installed, not logged in, unsupported CLI version, network error, or response format changed.
- Display exact reset date/time in a tooltip or secondary line.
- Open vendor usage/login pages only after an explicit click.

## 5. Application architecture

Keep vendor and credential logic entirely in Electron's main process.

```text
┌──────────────────────────────────────────────────────┐
│ Electron main process                                │
│                                                      │
│ TrayController ─ PopoverController                   │
│        │                  │                          │
│        └──────── UsageService ─ RefreshScheduler     │
│                         │                            │
│                 ┌───────┴────────┐                   │
│                 │                │                   │
│          CodexAdapter      ClaudeAdapter             │
│                 │                │                   │
│       codex app-server    CLI auth + usage endpoint  │
└───────────────────────────┬──────────────────────────┘
                            │ narrow, validated IPC
┌───────────────────────────┴──────────────────────────┐
│ Preload: contextBridge API                           │
├──────────────────────────────────────────────────────┤
│ React renderer: presentation only                    │
└──────────────────────────────────────────────────────┘
```

### Normalized provider model

Both adapters should return one common model:

```ts
type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;       // normalized to 0..100
  resetsAt: string | null;   // ISO timestamp
  durationMinutes: number | null;
};

type ProviderUsage = {
  provider: "codex" | "claude";
  status: "ok" | "stale" | "not-installed" | "logged-out" | "error";
  plan: string | null;
  accountLabel: string | null;
  windows: UsageWindow[];
  creditBalance?: string | null;
  fetchedAt: string | null;
  sourceVersion: string | null;
  error?: { code: string; message: string };
};
```

Keep the model tolerant of providers adding, removing, or renaming windows. The UI should render a list instead of assuming exactly two quota bars.

### IPC API

Expose only a small API through `contextBridge`:

- `usage.getSnapshot()`
- `usage.refresh()`
- `usage.onSnapshotChanged(callback)`
- `settings.get()` / `settings.update(safeSubset)`
- `app.openExternal(allowlistedDestination)`
- `app.quit()`

Do not expose arbitrary command execution, filesystem access, raw provider responses, or credentials to the renderer.

## 6. Provider integration

### 6.1 Codex adapter

This is the cleaner integration.

The installed Codex CLI currently exposes an experimental JSON-RPC app server. Its generated protocol includes:

- `initialize`
- `account/rateLimits/read`
- `account/rateLimits/updated`
- `account/usage/read`

`account/rateLimits/read` returns primary and secondary windows containing `usedPercent`, `windowDurationMins`, and `resetsAt`, plus plan and optional credit information.

Implementation:

1. Locate `codex` without relying only on a terminal's `PATH`. Check configured path and common locations such as `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`.
2. Run `codex --version` and enforce a tested minimum version.
3. Spawn `codex app-server --listen stdio://` with `shell: false`.
4. Send the required `initialize` request.
5. Send `account/rateLimits/read` with undefined/no parameters.
6. Parse newline-delimited JSON-RPC and validate the result with Zod.
7. Prefer `rateLimitsByLimitId`; fall back to the backward-compatible `rateLimits` value.
8. Normalize all available primary/secondary windows and credits.
9. Keep the process alive while the app runs, restart it once after an unexpected exit, and terminate it during app shutdown.

This lets Codex own its login and token refresh. The tracker does **not** need to read `~/.codex/auth.json`.

Risk: the app-server command is marked experimental. Keep all protocol handling in one adapter, store fixtures from each supported CLI version, ignore unknown fields, and show an “update required” message instead of guessing when validation fails.

### 6.2 Claude Code adapter

This is the main technical risk.

The installed Claude CLI provides a stable machine-readable auth check:

```sh
claude auth status --json
```

It reports login state and subscription type without exposing a token. Claude Code itself obtains quota data from `GET /api/oauth/usage`; current response concepts include:

- `five_hour`
- `seven_day`
- model-scoped weekly windows such as `seven_day_opus` and `seven_day_sonnet`
- `utilization`
- `resets_at`

However, there is currently no documented standalone CLI command or public subscription-quota API intended for third-party desktop applications. The OAuth usage endpoint and credential/refresh behavior must therefore be treated as **private and changeable**.

Implementation for the personal MVP:

1. Locate `claude` and call `claude auth status --json`.
2. If logged out, show a button that opens Terminal instructions for `claude auth login`.
3. In a dedicated credential service, reuse the OAuth credential from the same macOS Keychain/file location used by Claude Code. Request explicit consent before the first access.
4. Fetch the same OAuth usage endpoint with a five-second timeout and the headers proven by the feasibility spike.
5. Handle access-token refresh and rotated refresh tokens atomically, matching the installed CLI's behavior. Never copy the credential into app preferences.
6. Validate a permissive response schema and normalize utilization from `0..1` to `0..100`.
7. On authentication uncertainty, fail closed and ask the user to run Claude login again. Never repeatedly refresh or overwrite credential data.

Local-only scope decision: because this app will never be distributed, the private endpoint's brittleness is an acceptable personal maintenance trade-off. There is no need to support arbitrary users or credential configurations. The adapter must still protect credentials and fail safely; if the installed Claude CLI changes, update the adapter for this machine rather than adding risky compatibility work.

Fallback if the Claude feasibility spike fails:

- Run the app with Codex tracking only.
- For Claude, show auth status plus an **Open Claude usage page** button.
- Do not scrape browser pages or ask the user to paste a long-lived token.

## 7. Refresh and caching policy

- Fetch immediately after app launch.
- Refresh when the popover opens if data is older than two minutes.
- Background refresh every five minutes with small random jitter.
- Manual refresh is always available but deduplicated with an in-flight request.
- Refresh providers concurrently and isolate their failures.
- Apply a five-second network/process timeout per attempt.
- At most one controlled retry for a transient process/network failure; never retry a 401 loop.
- Refresh after macOS wakes from sleep or the network becomes reachable.
- Keep the latest normalized successful snapshot in memory.
- Optionally persist only normalized quota values and timestamps so the popover can display “last updated” data after restart. Never persist raw responses, tokens, cookies, or authorization headers.

## 8. Electron/macOS implementation details

### Tray and popover

- Create `Tray` only after `app.whenReady()` and retain a global reference.
- Use `iconTemplate.png` and `iconTemplate@2x.png` so macOS adapts the icon to light/dark menu bars.
- Hide the Dock icon with `app.dock.hide()` and set `LSUIElement` in the packaged app metadata.
- Use a hidden, frameless, non-resizable `BrowserWindow`, approximately 380 × 480 points.
- Position it from `tray.getBounds()` and clamp it to the active display's work area.
- Use `showInactive()` or `show()` based on tested keyboard-focus behavior.
- Hide on `blur`; do not destroy and recreate it on every click.
- Use an opaque fallback and optionally macOS `vibrancy: "popover"` if it behaves consistently.
- Request the single-instance lock so two menu-bar icons cannot appear.

### Renderer security

Use:

```ts
webPreferences: {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}
```

Also:

- Add a strict Content Security Policy.
- Load only bundled local content.
- Deny unexpected navigation and window creation.
- Validate every IPC request and response.
- Use `spawn`/`execFile` with an absolute executable path and `shell: false`.
- Redact account identifiers and all auth material from logs.
- Do not run a local HTTP server.

### Preferences

Store a small validated JSON file under Electron's `userData` directory:

- launch at login
- background refresh interval
- whether to show a percentage in the menu bar
- warning threshold
- explicitly selected CLI paths
- whether normalized stale snapshots may be persisted

Use `app.setLoginItemSettings()` only after the user enables launch at login.

## 9. Suggested project layout

```text
llm-usage-tracker/
├── PLAN.md
├── package.json
├── forge.config.ts
├── vite.main.config.ts
├── vite.preload.config.ts
├── vite.renderer.config.ts
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── tray-controller.ts
│   │   ├── popover-controller.ts
│   │   ├── ipc.ts
│   │   ├── usage-service.ts
│   │   ├── refresh-scheduler.ts
│   │   ├── cli-resolver.ts
│   │   ├── preferences.ts
│   │   └── providers/
│   │       ├── provider.ts
│   │       ├── codex/
│   │       │   ├── codex-adapter.ts
│   │       │   ├── app-server-client.ts
│   │       │   └── schemas.ts
│   │       └── claude/
│   │           ├── claude-adapter.ts
│   │           ├── credential-service.ts
│   │           └── schemas.ts
│   ├── preload/
│   │   └── index.ts
│   ├── renderer/
│   │   ├── app.tsx
│   │   ├── components/
│   │   └── styles/
│   └── shared/
│       ├── usage-types.ts
│       └── ipc-contract.ts
├── assets/
│   ├── tray/iconTemplate.png
│   └── app/icon.icns
└── tests/
    ├── fixtures/
    ├── unit/
    └── integration/
```

## 10. Delivery phases

### Phase 0 — Feasibility spikes (0.5–1.5 days)

Do this before designing the full UI.

- Prove a TypeScript script can initialize the installed Codex app server and read rate limits.
- Prove how Claude credentials are stored, refreshed, and safely read on macOS.
- Fetch and record sanitized Claude usage response fixtures.
- Confirm that no request consumes quota.
- Document supported CLI versions and failure behavior.

Versions observed while creating this plan:

- Codex CLI: `0.145.0`
- Claude Code: `2.1.218`

**Gate:** if secure Claude access cannot be demonstrated without corrupting or duplicating credentials, use the fallback rather than weakening security.

### Phase 1 — App shell (1 day)

- Scaffold Electron Forge + Vite + React + TypeScript.
- Add tray icon, hidden Dock mode, popover positioning, close-on-blur, and Quit.
- Add secure preload and typed IPC skeleton.

### Phase 2 — Provider layer (1.5–2.5 days)

- Define normalized models and provider interface.
- Implement CLI resolution and timeouts.
- Implement Codex adapter and JSON-RPC client.
- Implement the outcome of the Claude spike.
- Add fixtures and adapter tests.

### Phase 3 — UI and refresh lifecycle (1–1.5 days)

- Build quota cards, progress bars, reset-time formatting, stale/loading/error states, and refresh control.
- Add refresh scheduling, sleep/wake handling, and cached snapshots.
- Add accessible keyboard navigation and reduced-motion support.

### Phase 4 — Hardening (1–2 days)

- Add strict CSP, IPC validation, URL allowlists, log redaction, process cleanup, and single-instance behavior.
- Test logged-out, missing CLI, malformed response, offline, timeout, 401, sleep/wake, multiple monitors, and dark/light modes.
- Check idle CPU and memory.

### Phase 5 — Local app packaging (0.5 day)

- Add app/tray artwork and `LSUIElement` metadata.
- Produce an Apple Silicon `.app` with Electron Forge and optionally copy it to `/Applications`.
- Test local launch and launch-at-login on this Mac.
- Skip DMG/ZIP makers, Developer ID signing, Apple notarization, auto-update, and clean-machine testing. Use ad-hoc local signing only if macOS requires a stable identity for local behavior.

Estimated personal MVP: **5–8 working days**, mostly depending on Claude's private integration. There is no public-release phase.

## 11. Test strategy

### Unit tests

- Normalize all known Codex and Claude quota windows.
- Clamp or reject invalid utilization values.
- Parse Unix seconds, ISO dates, missing reset times, and daylight-saving transitions.
- Verify renderer-safe error mapping and credential redaction.
- Test refresh deduplication, stale data, and provider-isolated failures.

### Integration tests

- Use fake `codex` and `claude` executables to test process lifecycle and malformed output.
- Replay sanitized JSON-RPC and HTTP fixtures.
- Test app-server exit/restart and request timeout behavior.
- Keep optional live-provider tests behind an explicit environment flag; never run them in CI.

### macOS smoke tests

- Menu-bar icon in light/dark mode.
- Popover placement on left/right edge and secondary displays.
- Focus, Escape, blur, and Space/Enter keyboard behavior.
- No Dock icon and no duplicate instances.
- Sleep/wake, offline/online, launch at login, and the locally packaged build.

## 12. MVP acceptance criteria

- The app starts as one menu-bar icon with no Dock icon.
- Clicking it opens a correctly positioned popover.
- Authenticated Codex quota windows and reset times are shown accurately.
- Authenticated Claude quota windows are shown if the feasibility gate passes; otherwise the safe fallback is clear.
- One provider failing does not hide the other provider's data.
- Values refresh automatically and manually without creating paid model requests.
- Missing/outdated CLIs and logged-out accounts produce actionable messages.
- No credential or authorization data reaches the renderer, cache, or logs.
- The local `.app` runs from the Forge output directory or `/Applications`; no distributable installer is required.

## 13. Later enhancements

After the MVP is reliable:

- Warning notifications at configurable thresholds, such as 80% and 95% used.
- A menu-bar percentage/title mode.
- Sparkline history based only on normalized snapshots.
- A developer diagnostic view for adapter/version failures.
- A script for refreshing sanitized fixtures after local CLI updates.
- Additional providers behind the same adapter interface.

## 14. Immediate next step

Implement only the two Phase 0 command-line spikes first. The Codex path is already promising; Claude credential refresh and private endpoint stability are the go/no-go item for the rest of the architecture.
