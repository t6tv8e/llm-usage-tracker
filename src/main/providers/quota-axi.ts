import { ChildProcess, spawn } from 'node:child_process';
import { UsageErrorCode, ProviderId, UsageSnapshot, UsageWindow, UsageWindowKind } from '../../shared/types';
import { debugLog } from '../logger';
import { asRecord, clampPercent, normalizeTimestamp, providerLabel, usageError } from './common';

const SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
// How long to back off before retrying after a transient failure, and the
// longer window used when a hard dependency (the CLI itself) is missing.
const SHORT_RETRY_MS = 5 * 60_000;
const DEPENDENCY_RETRY_MS = 15 * 60_000;

interface QuotaAxiClientOptions {
  cliPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface RunResult {
  stdout: string;
  exitCode: number | null;
}

function bundledCliPath(): string {
  return require.resolve('quota-axi/dist/bin/quota-axi.js');
}

function percentage(window: Record<string, unknown>): number | null {
  if (typeof window.percentUsed === 'number' && Number.isFinite(window.percentUsed)) {
    return clampPercent(window.percentUsed);
  }
  if (typeof window.percentRemaining === 'number' && Number.isFinite(window.percentRemaining)) {
    return clampPercent(100 - window.percentRemaining);
  }
  if (typeof window.spentUsd === 'number' && Number.isFinite(window.spentUsd)
    && typeof window.limitUsd === 'number' && Number.isFinite(window.limitUsd)
    && window.limitUsd > 0) {
    return clampPercent(window.spentUsd / window.limitUsd * 100);
  }
  return null;
}

function windowKind(value: unknown): UsageWindowKind {
  if (value === 'session') return 'session';
  if (value === 'weekly' || value === 'model') return 'weekly';
  return 'other';
}

function normalizeWindow(value: unknown): UsageWindow | null {
  const record = asRecord(value);
  if (!record || typeof record.label !== 'string') return null;
  const usedPercent = percentage(record);
  if (usedPercent === null) return null;
  const seconds = typeof record.windowSeconds === 'number' && Number.isFinite(record.windowSeconds)
    ? record.windowSeconds
    : null;
  return {
    kind: windowKind(record.kind),
    label: record.label,
    usedPercent,
    resetsAt: normalizeTimestamp(record.resetsAt),
    windowMinutes: seconds === null ? null : Math.round(seconds / 60),
  };
}

function parseRetryAt(value: unknown, now: number): number {
  const parsed = normalizeTimestamp(value);
  return parsed !== null && parsed > now ? parsed : now + SHORT_RETRY_MS;
}

function mappedError(
  provider: ProviderId,
  state: Record<string, unknown>,
  now: number,
): ReturnType<typeof usageError> | null {
  const label = providerLabel(provider);
  if (state.status === 'fresh' && state.stale !== true) return null;
  if (state.reason === 'keychain_access_required') {
    return usageError('keychain-denied', 'Claude Keychain access is required. Refresh manually to allow access.');
  }
  if (state.status === 'auth_required') {
    return usageError('token-expired', `${label} authentication is required. Open ${label} to sign in.`);
  }
  if (state.status === 'rate_limited') {
    return usageError('rate-limited', `${label} usage is temporarily rate limited.`, parseRetryAt(state.retryAfter, now));
  }
  if (state.status === 'stale' || state.stale === true) {
    return usageError('network', `${label} usage is temporarily unavailable; cached quota is shown.`, now + SHORT_RETRY_MS);
  }
  const rawError = typeof state.error === 'string' ? state.error : '';
  const dependencyMissing = /(?:not found|not[_ -]?executable|missing|unavailable).*(?:cli|binary|dependency)|(?:cli|binary|dependency).*(?:not found|not[_ -]?executable|missing|unavailable)/i.test(rawError);
  if (dependencyMissing) {
    return usageError('cli-missing', `${label} quota dependency is unavailable.`, now + DEPENDENCY_RETRY_MS);
  }
  if (state.status === 'unavailable') {
    return usageError('network', `${label} usage is temporarily unavailable.`, now + SHORT_RETRY_MS);
  }
  return usageError('parse', `${label} usage could not be read.`, now + SHORT_RETRY_MS);
}

function failureSnapshot(provider: ProviderId, code: UsageErrorCode, message: string): UsageSnapshot {
  const now = Date.now();
  return {
    provider,
    ok: false,
    fetchedAt: now,
    planType: null,
    windows: [],
    error: usageError(code, message, now + SHORT_RETRY_MS),
    source: 'quota-axi',
  };
}

function normalizeProvider(value: unknown, generatedAt: number, expected: ProviderId): UsageSnapshot {
  const provider = asRecord(value);
  const state = asRecord(provider?.state);
  if (!provider || provider.provider !== expected || !state || !Array.isArray(provider.windows)) {
    return failureSnapshot(expected, 'parse', `${providerLabel(expected)} quota data was malformed.`);
  }
  const fetchedAt = normalizeTimestamp(state.refreshedAt) ?? generatedAt;
  const windows = provider.windows
    .map(normalizeWindow)
    .filter((window): window is UsageWindow => window !== null);
  const error = mappedError(expected, state, Date.now());
  return {
    provider: expected,
    ok: error === null,
    fetchedAt,
    planType: typeof provider.plan === 'string' ? provider.plan : null,
    windows,
    error,
    source: provider.source === 'cache' || state.stale === true ? 'quota-axi-cache' : 'quota-axi',
  };
}

export function parseQuotaAxiResponse(stdout: string, requested: ProviderId[]): Record<ProviderId, UsageSnapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('quota-axi returned malformed JSON');
  }
  const response = asRecord(parsed);
  if (!response || response.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`quota-axi schema version ${SCHEMA_VERSION} is required`);
  }
  if (typeof response.generatedAt !== 'string' || !Array.isArray(response.providers)) {
    throw new Error('quota-axi response shape is invalid');
  }
  const generatedAt = normalizeTimestamp(response.generatedAt);
  if (generatedAt === null) throw new Error('quota-axi generatedAt is invalid');

  const byProvider = new Map<ProviderId, unknown>();
  for (const value of response.providers) {
    const provider = asRecord(value)?.provider;
    if (provider !== 'claude' && provider !== 'codex') continue;
    if (byProvider.has(provider)) throw new Error(`quota-axi returned duplicate provider ${provider}`);
    byProvider.set(provider, value);
  }
  for (const provider of requested) {
    if (!byProvider.has(provider)) throw new Error(`quota-axi omitted requested provider ${provider}`);
  }

  const result = {} as Record<ProviderId, UsageSnapshot>;
  for (const provider of requested) result[provider] = normalizeProvider(byProvider.get(provider), generatedAt, provider);
  return result;
}

export class QuotaAxiClient {
  private readonly cliPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly children = new Set<ChildProcess>();

  constructor(options: QuotaAxiClientOptions = {}) {
    this.cliPath = options.cliPath ?? bundledCliPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async fetch(providers: ProviderId[], allowKeychainPrompt: boolean): Promise<Record<ProviderId, UsageSnapshot>> {
    if (providers.length === 0) return {} as Record<ProviderId, UsageSnapshot>;
    let result: RunResult;
    try {
      result = await this.run(providers, allowKeychainPrompt);
    } catch (error) {
      debugLog('quota-axi', `run failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return Object.fromEntries(providers.map((provider) => [
        provider,
        failureSnapshot(provider, 'cli-missing', 'The bundled quota service could not be started.'),
      ])) as Record<ProviderId, UsageSnapshot>;
    }
    try {
      return parseQuotaAxiResponse(result.stdout, providers);
    } catch (error) {
      debugLog('quota-axi', `parse failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return Object.fromEntries(providers.map((provider) => [
        provider,
        failureSnapshot(provider, 'parse', 'The bundled quota service returned unreadable data.'),
      ])) as Record<ProviderId, UsageSnapshot>;
    }
  }

  stop(): void {
    // Kill every child that may still be in flight, not just the most recent
    // one, so overlapping fetches cannot leak processes on shutdown.
    for (const child of this.children) child.kill();
    this.children.clear();
  }

  private run(providers: ProviderId[], allowKeychainPrompt: boolean): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const args = [
        this.cliPath,
        '--provider',
        providers.join(','),
        '--json',
        ...(allowKeychainPrompt ? ['--allow-keychain-prompt'] : []),
      ];
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.children.add(child);
      let stdout = '';
      let outputBytes = 0;
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        callback();
      };
      const fail = (message: string): void => finish(() => {
        child.kill();
        reject(new Error(message));
      });
      const onData = (chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) {
          fail('quota-axi output limit exceeded');
          return;
        }
        stdout += chunk.toString('utf8');
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) fail('quota-axi output limit exceeded');
      });
      child.on('error', () => fail('quota-axi process failed'));
      child.on('exit', (exitCode) => finish(() => {
        if (stdout.trim() === '') {
          reject(new Error(`quota-axi exited ${exitCode ?? 'without a status'} and returned no JSON`));
        } else {
          resolve({ stdout, exitCode });
        }
      }));
      const timer = setTimeout(() => fail('quota-axi timed out'), this.timeoutMs);
    });
  }
}
