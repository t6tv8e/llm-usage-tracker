'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RefreshScheduler } = require('../dist/main/scheduler');

const settings = {
  trayMode: 'icon',
  pollIntervalMinutes: 1440,
  warnAtPercent: 80,
  launchAtLogin: false,
};

function snapshot(provider, options = {}) {
  return {
    provider,
    ok: options.ok ?? true,
    fetchedAt: options.fetchedAt ?? 100,
    planType: options.planType ?? null,
    windows: options.windows ?? [{
      kind: 'weekly',
      label: 'Weekly',
      usedPercent: provider === 'codex' ? 20 : 30,
      resetsAt: null,
      windowMinutes: 10080,
    }],
    error: options.error ?? null,
    source: options.source ?? 'quota-axi',
  };
}

function schedulerWith(client, initialState = { claude: null, codex: null, refreshing: false }) {
  return new RefreshScheduler({
    initialState,
    getSettings: () => settings,
    persist: async () => {},
    client,
  });
}

test('batches all due providers into one process request', async () => {
  const calls = [];
  const client = {
    fetch: async (providers, prompt) => {
      calls.push({ providers, prompt });
      return { claude: snapshot('claude'), codex: snapshot('codex') };
    },
    stop() {},
  };
  const scheduler = schedulerWith(client);
  try {
    await scheduler.refresh(false);
    assert.deepEqual(calls, [{ providers: ['codex', 'claude'], prompt: false }]);
  } finally {
    scheduler.stop();
  }
});

test('preserves provider-specific retry gates and manual bypass with prompting', async () => {
  const calls = [];
  const retryAt = Date.now() + 60_000;
  const initial = {
    claude: snapshot('claude', {
      ok: false,
      error: { code: 'rate-limited', message: 'limited', retryAt },
    }),
    codex: snapshot('codex'),
    refreshing: false,
  };
  const client = {
    fetch: async (providers, prompt) => {
      calls.push({ providers, prompt });
      return Object.fromEntries(providers.map((provider) => [provider, snapshot(provider)]));
    },
    stop() {},
  };
  const scheduler = schedulerWith(client, initial);
  try {
    await scheduler.refresh(false);
    await scheduler.refresh(true);
    assert.deepEqual(calls, [
      { providers: ['codex'], prompt: false },
      { providers: ['codex', 'claude'], prompt: true },
    ]);
  } finally {
    scheduler.stop();
  }
});

test('deduplicates concurrent refreshes', async () => {
  let resolveFetch;
  let calls = 0;
  const client = {
    fetch: () => {
      calls += 1;
      return new Promise((resolve) => { resolveFetch = resolve; });
    },
    stop() {},
  };
  const scheduler = schedulerWith(client);
  try {
    const first = scheduler.refresh(false);
    const second = scheduler.refresh(false);
    assert.equal(first, second);
    resolveFetch({ claude: snapshot('claude'), codex: snapshot('codex') });
    await first;
    assert.equal(calls, 1);
  } finally {
    scheduler.stop();
  }
});

test('upgrades an in-flight background refresh when a forced refresh is requested', async () => {
  const calls = [];
  const resolvers = [];
  const client = {
    fetch: (providers, prompt) => {
      calls.push({ providers, prompt });
      return new Promise((resolve) => { resolvers.push({ resolve, providers }); });
    },
    stop() {},
  };
  const initial = {
    claude: snapshot('claude', {
      ok: false,
      error: { code: 'rate-limited', message: 'limited', retryAt: Date.now() + 60_000 },
    }),
    codex: snapshot('codex'),
    refreshing: false,
  };
  const settle = (index) => resolvers[index].resolve(
    Object.fromEntries(resolvers[index].providers.map((provider) => [provider, snapshot(provider)])),
  );
  const scheduler = schedulerWith(client, initial);
  try {
    const background = scheduler.refresh(false); // claude is retry-gated, so only codex, no prompt
    const forced = scheduler.refresh(true);      // requested while the background pass is in flight
    assert.equal(calls.length, 1);               // not answered by a second fetch yet
    settle(0);
    await background;
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the chained forced pass start
    assert.equal(calls.length, 2);
    settle(1);
    await forced;
    assert.deepEqual(calls, [
      { providers: ['codex'], prompt: false },
      { providers: ['codex', 'claude'], prompt: true },
    ]);
  } finally {
    scheduler.stop();
  }
});

test('preserves last-known windows after an independent provider failure', async () => {
  const oldClaude = snapshot('claude', { fetchedAt: 123, source: 'quota-axi-cache' });
  const client = {
    fetch: async () => ({
      claude: snapshot('claude', {
        ok: false,
        fetchedAt: 999,
        windows: [],
        error: { code: 'network', message: 'unavailable', retryAt: Date.now() + 60_000 },
      }),
      codex: snapshot('codex', { fetchedAt: 999 }),
    }),
    stop() {},
  };
  const scheduler = schedulerWith(client, {
    claude: oldClaude,
    codex: snapshot('codex', { fetchedAt: 123 }),
    refreshing: false,
  });
  try {
    const state = await scheduler.refresh(false);
    assert.equal(state.claude.ok, false);
    assert.equal(state.claude.fetchedAt, 123);
    assert.deepEqual(state.claude.windows, oldClaude.windows);
    assert.equal(state.claude.source, 'quota-axi-cache');
    assert.equal(state.codex.ok, true);
    assert.equal(state.codex.fetchedAt, 999);
  } finally {
    scheduler.stop();
  }
});
