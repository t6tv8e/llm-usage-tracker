# LLM Usage

A local-only macOS menu bar app that displays Codex and Claude Code subscription quota usage.

The app uses Electron, TypeScript, `menubar`, and the pinned `quota-axi@0.1.11` CLI. `quota-axi` is the sole quota data source: the app does not implement provider credentials, HTTP calls, Codex app-server access, or session-file parsing itself.

## Quick start

Requirements:

- macOS
- Node.js 22.19 or newer
- local Codex and/or Claude Code authentication that `quota-axi` can inspect

```sh
npm install
npm start
```

`quota-axi` is an explicit production dependency and its bundled `dist/bin/quota-axi.js` is executed with the current Node runtime. The app never uses `npx`, a global installation, `PATH`, or a network install at refresh time.

Claude Keychain access is never allowed to prompt during startup or background polling. Click the refresh button to perform a user-initiated refresh that permits a one-time macOS Keychain prompt.

## Architecture

```text
Local provider credentials and first-party quota services
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│ Main process                                             │
│ bundled quota-axi CLI → adapter → scheduler → AppState   │
│ settings, snapshots, tray title, secure IPC              │
└───────────────────────────┬──────────────────────────────┘
                            │ narrow IPC API
                            ▼
┌──────────────────────────────────────────────────────────┐
│ Sandboxed preload → plain TypeScript renderer            │
└──────────────────────────────────────────────────────────┘
```

Each refresh runs at most one child process for all due providers:

```sh
node node_modules/quota-axi/dist/bin/quota-axi.js \
  --provider codex,claude --json
```

In packaged Electron builds, the same file is run with `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, so the embedded runtime executes it without a global Node installation.

The adapter accepts only quota schema version 2. It bounds child output to 1 MiB, times out after 75 seconds, parses structured stdout even after a nonzero exit, requires every requested provider to be present, and terminates the child during application shutdown.

## Data model and refresh behavior

The renderer receives only normalized `UsageSnapshot` objects:

- `state.refreshedAt` is the snapshot timestamp, with response `generatedAt` as fallback.
- session windows remain session windows.
- weekly and model windows render as weekly.
- monthly, credits, and unknown windows render as other.
- `percentUsed` is preferred; percentages can also be derived from `percentRemaining` or `spentUsd / limitUsd`.
- windows without a usable percentage are omitted.
- reset ISO timestamps and `windowSeconds` become the existing timestamp and minute fields.

Account identity, source attempts, raw output, and top-level Codex credit balances are neither normalized nor exposed to the renderer.

The scheduler preserves:

- one in-flight refresh shared by concurrent callers
- independent Claude and Codex results
- provider-specific retry gates
- manual refresh bypass of retry gates
- normalized startup snapshots
- last-known windows when a later refresh fails

Fresh data uses the source `quota-axi`; stale data returned from the quota cache uses `quota-axi-cache` and is labeled as cached in the popover.

Background polling uses the configured interval with small jitter and a three-minute minimum. Opening the popover refreshes snapshots older than two minutes. After sleep, the app schedules a background refresh after five seconds.

## Security

All process execution and filesystem access happen in the main process. The renderer receives only normalized percentages, reset data, plan labels, and safe error messages.

Renderer controls include:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- strict Content Security Policy
- denied navigation, new windows, and permission requests
- allowlisted external usage-page links

Neither settings nor snapshots contain credentials or raw provider responses.

## Source tree

```text
src/
  shared/types.ts
  main/
    index.ts
    ipc.ts
    scheduler.ts
    settings.ts
    tray-title.ts
    providers/
      common.ts
      quota-axi.ts
  preload/preload.ts
  renderer/
scripts/
  probe.ts
tests/
  fixtures/
  providers.test.js
  scheduler.test.js
  tray-title.test.js
```

## Development commands

```sh
npm run build
npm start
npm run watch
npm test
npm run probe
```

`npm run probe` performs one live, manual-style Codex+Claude batch request through the same bundled adapter and prints only normalized snapshots.

## Package for this Mac

```sh
npm run package:mac
cp -R "out/LLM Usage-darwin-arm64/LLM Usage.app" /Applications/
```

The build is unsigned and intended for local use. The packaged app includes the pinned production `quota-axi` dependency and uses Electron's embedded Node runtime to execute it.
