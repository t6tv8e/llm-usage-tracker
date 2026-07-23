import { ProviderId, UsageError, UsageErrorCode } from '../../shared/types';

export function providerLabel(provider: ProviderId): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

export function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Usage percentage is not a finite number');
  }
  return Math.min(100, Math.max(0, value));
}

export function normalizeTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (value.trim() !== '' && Number.isFinite(numeric)) return normalizeTimestamp(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function usageError(code: UsageErrorCode, message: string, retryAt?: number): UsageError {
  return retryAt === undefined ? { code, message } : { code, message, retryAt };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
