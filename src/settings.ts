import { DEFAULT_THEME, type Theme } from './color.ts';

export type Engine = 'dynamic' | 'filter';
export type SiteMode = Engine | 'off';
export type Automation = 'always' | 'system' | 'time';
export type FixAction = 'invert' | 'dim';
/** Elements a user fixed with the picker: per host, `[selector, action]`. */
export type UserFixes = Record<string, [selector: string, action: FixAction][]>;

/**
 * What a page runs. `auto-*` uses the default engine but steps aside when
 * the site is already dark; an explicit per-site engine always applies.
 */
export type Mode = `auto-${Engine}` | Engine | 'off';
export const MODES: Mode[] = ['auto-dynamic', 'auto-filter', 'dynamic', 'filter', 'off'];

export interface Settings extends Theme {
  enabled: boolean;
  defaultEngine: Engine;
  automation: Automation;
  /** "HH:MM", local time. The range may wrap past midnight. */
  timeFrom: string;
  timeTo: string;
  siteModes: Record<string, SiteMode>;
  /** Allow-list mode: only sites given their own mode are touched. */
  onlyListed: boolean;
  /** Auto mode steps aside on sites that are dark already. */
  detectDark: boolean;
  /** Lighten visible text that falls below WCAG AA against what's really behind it. */
  fixContrast: boolean;
  /** Keep generated CSS per site locally so repeat visits go dark instantly. Never in Incognito. */
  rememberSites: boolean;
  userFixes: UserFixes;
}

export const DEFAULTS: Settings = {
  enabled: true,
  defaultEngine: 'dynamic',
  automation: 'always',
  timeFrom: '19:00',
  timeTo: '07:00',
  ...DEFAULT_THEME,
  siteModes: {},
  onlyListed: false,
  detectDark: true,
  fixContrast: true,
  rememberSites: true,
  userFixes: {},
};

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) } as Settings;
}

export function setSettings(patch: Partial<Settings>): Promise<void> {
  return chrome.storage.sync.set(patch);
}

export function themeOf(s: Settings): Theme {
  const { brightness, contrast, sepia, grayscale, bgColor, fgColor } = s;
  return { brightness, contrast, sepia, grayscale, bgColor, fgColor };
}

/** Hostname for http(s) pages; null for pages we can't or shouldn't touch. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : null;
  } catch {
    return null;
  }
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function inTimeRange(s: Settings, now = new Date()): boolean {
  const t = now.getHours() * 60 + now.getMinutes();
  const from = minutes(s.timeFrom);
  const to = minutes(s.timeTo);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/** Milliseconds until the time automation next flips. */
export function msToNextBoundary(s: Settings, now = new Date()): number {
  const t = now.getHours() * 60 + now.getMinutes();
  const deltas = [minutes(s.timeFrom), minutes(s.timeTo)].map((b) => (b - t + 1440) % 1440 || 1440);
  return Math.min(...deltas) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
}

/** The site's mode, ignoring automation that only the page can evaluate (system theme). */
export function siteMode(s: Settings, host: string, now = new Date()): Mode {
  if (!s.enabled) return 'off';
  if (s.automation === 'time' && !inTimeRange(s, now)) return 'off';
  return s.siteModes[host] ?? (s.onlyListed ? 'off' : `auto-${s.defaultEngine}`);
}

export function modeFor(s: Settings, host: string, systemDark: boolean): Mode {
  if (s.automation === 'system' && !systemDark) return 'off';
  return siteMode(s, host);
}

/** CSS for a site's picker fixes. */
export function userFixCss(fixes: UserFixes, host: string): string {
  let css = '';
  for (const [sel, action] of fixes[host] ?? []) {
    css += `:is(${sel}){filter:${action === 'invert' ? 'invert(1) hue-rotate(180deg)' : 'brightness(0.72)'}!important}`;
  }
  return css;
}
