'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeTrayPresentation } = require('../dist/main/tray-title');

const snapshot = (provider, values, ok = true) => ({
  provider,
  ok,
  fetchedAt: 1,
  planType: null,
  windows: values.map((usedPercent) => ({ kind: 'weekly', label: 'Weekly', usedPercent, resetsAt: null, windowMinutes: 10080 })),
  error: ok ? null : { code: 'network', message: 'offline' },
  source: 'quota-axi',
});
const settings = { trayMode: 'both', pollIntervalMinutes: 5, warnAtPercent: 80, launchAtLogin: false };

test('both mode shows each provider worst window', () => {
  const state = { claude: snapshot('claude', [12, 42]), codex: snapshot('codex', [7]), refreshing: false };
  assert.equal(computeTrayPresentation(state, settings).title, 'C 42% · X 7%');
});

test('highest mode marks warning and critical levels', () => {
  const state = { claude: snapshot('claude', [81]), codex: snapshot('codex', [95]), refreshing: false };
  const result = computeTrayPresentation(state, { ...settings, trayMode: 'highest' });
  assert.equal(result.title, 'X 95% ⚠');
  assert.equal(result.warning, true);
  assert.equal(result.critical, true);
});

test('failed provider renders as a dash', () => {
  const state = { claude: snapshot('claude', [], false), codex: snapshot('codex', [7]), refreshing: false };
  assert.equal(computeTrayPresentation(state, settings).title, 'C –% · X 7%');
});
