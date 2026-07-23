'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { QuotaAxiClient, parseQuotaAxiResponse } = require('../dist/main/providers/quota-axi');

function fixture(name) {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

function temporaryScript(source) {
  const directory = mkdtempSync(join(tmpdir(), 'llm-usage-quota-axi-'));
  const path = join(directory, 'fake-quota-axi.mjs');
  writeFileSync(path, source);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('normalizes fresh percentages, timestamps, durations, and plan', () => {
  const { codex } = parseQuotaAxiResponse(fixture('quota-axi-fresh.json'), ['codex']);
  assert.equal(codex.ok, true);
  assert.equal(codex.source, 'quota-axi');
  assert.equal(codex.planType, 'plus');
  assert.equal(codex.fetchedAt, Date.parse('2026-07-23T10:01:00Z'));
  assert.deepEqual(codex.windows.map(({ kind, usedPercent, windowMinutes }) => (
    { kind, usedPercent, windowMinutes }
  )), [
    { kind: 'session', usedPercent: 42.5, windowMinutes: 300 },
    { kind: 'weekly', usedPercent: 75, windowMinutes: 10080 },
  ]);
  assert.equal(codex.windows[0].resetsAt, Date.parse('2026-07-23T12:00:00Z'));
});

test('maps stale quota to cache source and keeps displayable windows', () => {
  const { claude } = parseQuotaAxiResponse(fixture('quota-axi-stale.json'), ['claude']);
  assert.equal(claude.ok, false);
  assert.equal(claude.source, 'quota-axi-cache');
  assert.equal(claude.error.code, 'network');
  assert.equal(claude.windows.length, 1);
});

test('maps authentication, Keychain, rate-limit, unavailable, and dependency states', () => {
  const auth = parseQuotaAxiResponse(fixture('quota-axi-auth-required.json'), ['codex']).codex;
  const keychain = parseQuotaAxiResponse(fixture('quota-axi-keychain-required.json'), ['claude']).claude;
  const rate = parseQuotaAxiResponse(fixture('quota-axi-rate-limited.json'), ['claude']).claude;
  const unavailable = parseQuotaAxiResponse(fixture('quota-axi-unavailable.json'), ['codex']).codex;
  const dependency = parseQuotaAxiResponse(fixture('quota-axi-dependency-failure.json'), ['codex']).codex;
  assert.equal(auth.error.code, 'token-expired');
  assert.equal(keychain.error.code, 'keychain-denied');
  assert.equal(rate.error.code, 'rate-limited');
  assert.equal(rate.error.retryAt, Date.parse('2099-07-23T10:10:00Z'));
  assert.equal(unavailable.error.code, 'network');
  assert.equal(dependency.error.code, 'cli-missing');
});

test('derives spend percentages, maps non-session kinds, and omits non-percent windows', () => {
  const { claude } = parseQuotaAxiResponse(fixture('quota-axi-extra-usage.json'), ['claude']);
  assert.deepEqual(claude.windows.map(({ kind, usedPercent }) => ({ kind, usedPercent })), [
    { kind: 'other', usedPercent: 25 },
    { kind: 'other', usedPercent: 20 },
  ]);
  assert.equal(claude.fetchedAt, Date.parse('2026-07-23T10:00:00Z'));
});

test('keeps mixed provider results independent and does not expose top-level credits', () => {
  const result = parseQuotaAxiResponse(fixture('quota-axi-mixed.json'), ['codex', 'claude']);
  assert.equal(result.codex.ok, true);
  assert.equal(result.codex.windows[0].kind, 'weekly');
  assert.equal(result.claude.ok, false);
  assert.equal('credits' in result.codex, false);
});

test('rejects schema mismatch, malformed output, and missing requested providers', () => {
  assert.throws(() => parseQuotaAxiResponse('not json', ['codex']), /malformed JSON/);
  const wrongSchema = JSON.parse(fixture('quota-axi-fresh.json'));
  wrongSchema.schemaVersion = 1;
  assert.throws(() => parseQuotaAxiResponse(JSON.stringify(wrongSchema), ['codex']), /schema version 2/);
  assert.throws(() => parseQuotaAxiResponse(fixture('quota-axi-fresh.json'), ['claude']), /omitted requested provider/);
});

test('uses one bundled Node process, manual-only Keychain prompting, and parses valid JSON on nonzero exit', async () => {
  const captureDirectory = mkdtempSync(join(tmpdir(), 'llm-usage-quota-capture-'));
  const capturePath = join(captureDirectory, 'capture.json');
  const response = fixture('quota-axi-mixed.json');
  const script = temporaryScript(`
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      args: process.argv.slice(2),
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE
    }));
    console.log(${JSON.stringify(response)});
    process.exitCode = 7;
  `);
  const client = new QuotaAxiClient({ cliPath: script.path });
  try {
    const result = await client.fetch(['codex', 'claude'], true);
    assert.equal(result.codex.ok, true);
    assert.equal(result.claude.error.code, 'token-expired');
    const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.deepEqual(capture.args, ['--provider', 'codex,claude', '--json', '--allow-keychain-prompt']);
    assert.equal(capture.electronRunAsNode, '1');
  } finally {
    client.stop();
    script.cleanup();
    rmSync(captureDirectory, { recursive: true, force: true });
  }
});

test('does not pass the Keychain prompt flag for background calls', async () => {
  const response = fixture('quota-axi-fresh.json');
  const script = temporaryScript(`
    if (process.argv.includes('--allow-keychain-prompt')) process.exit(9);
    console.log(${JSON.stringify(response)});
  `);
  const client = new QuotaAxiClient({ cliPath: script.path });
  try {
    const result = await client.fetch(['codex'], false);
    assert.equal(result.codex.ok, true);
  } finally {
    script.cleanup();
  }
});

test('maps process failure without JSON, timeout, and output overflow without exposing output', async () => {
  const failing = temporaryScript('process.exit(4);');
  const hanging = temporaryScript('setTimeout(() => {}, 10000);');
  const noisy = temporaryScript('process.stdout.write("x".repeat(4096));');
  try {
    const failed = await new QuotaAxiClient({ cliPath: failing.path }).fetch(['codex'], false);
    const timedOut = await new QuotaAxiClient({ cliPath: hanging.path, timeoutMs: 20 }).fetch(['codex'], false);
    const overflow = await new QuotaAxiClient({ cliPath: noisy.path, maxOutputBytes: 64 }).fetch(['codex'], false);
    assert.equal(failed.codex.error.code, 'cli-missing');
    assert.equal(timedOut.codex.error.code, 'cli-missing');
    assert.equal(overflow.codex.error.code, 'cli-missing');
    assert.doesNotMatch(overflow.codex.error.message, /xxxx/);
  } finally {
    failing.cleanup();
    hanging.cleanup();
    noisy.cleanup();
  }
});

test('cancels the child process during shutdown', async () => {
  const hanging = temporaryScript('setTimeout(() => {}, 10000);');
  const client = new QuotaAxiClient({ cliPath: hanging.path, timeoutMs: 10_000 });
  try {
    const pending = client.fetch(['claude'], false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    client.stop();
    const result = await pending;
    assert.equal(result.claude.ok, false);
  } finally {
    hanging.cleanup();
  }
});

test('the production client resolves the pinned bundled CLI', () => {
  assert.match(require.resolve('quota-axi/dist/bin/quota-axi.js'), /node_modules[/\\]quota-axi[/\\]dist[/\\]bin/);
});
