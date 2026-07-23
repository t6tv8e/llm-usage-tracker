import { AppState, ProviderId, Settings, UsageSnapshot } from '../shared/types';

export interface TrayPresentation {
  title: string;
  warning: boolean;
  critical: boolean;
}

function worst(snapshot: UsageSnapshot | null): number | null {
  if (!snapshot?.ok || snapshot.windows.length === 0) return null;
  return Math.max(...snapshot.windows.map((window) => window.usedPercent));
}

function providerText(provider: ProviderId, percent: number | null): string {
  const prefix = provider === 'claude' ? 'C' : 'X';
  return `${prefix} ${percent === null ? '–' : Math.round(percent)}%`;
}

export function computeTrayPresentation(state: AppState, settings: Settings): TrayPresentation {
  const claude = worst(state.claude);
  const codex = worst(state.codex);
  const available = [claude, codex].filter((value): value is number => value !== null);
  const maximum = available.length > 0 ? Math.max(...available) : null;
  const warning = maximum !== null && maximum >= settings.warnAtPercent;
  const critical = maximum !== null && maximum >= 95;

  let title: string;
  switch (settings.trayMode) {
    case 'both':
      title = `${providerText('claude', claude)} · ${providerText('codex', codex)}`;
      break;
    case 'claude':
      title = providerText('claude', claude);
      break;
    case 'codex':
      title = providerText('codex', codex);
      break;
    case 'highest':
      if (claude === null && codex === null) title = '–%';
      else if (codex !== null && (claude === null || codex > claude)) title = providerText('codex', codex);
      else title = providerText('claude', claude);
      break;
    case 'icon':
    default:
      title = '';
      break;
  }
  if (warning) title = title ? `${title} ⚠` : '⚠';
  return { title, warning, critical };
}
