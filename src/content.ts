import { DEFAULT_THEME } from './color.ts';
import { isLocked, renderedDark } from './detect.ts';
import { DynamicTheme } from './dynamic.ts';
import { FilterTheme } from './filter.ts';
import type { SiteFix } from './fixes.ts';
import { getSettings, modeFor, msToNextBoundary, setSettings, themeOf, userFixCss, type Engine, type Mode, type Settings } from './settings.ts';

import type {} from './picker.ts';

declare global {
  /** Set by the flag file registered in front of this script; lets us start before storage answers. */
  var __dusk: { mode: Mode; sys: boolean } | undefined;
  /** The previous instance, left behind when the extension reloads. */
  var __duskTeardown: (() => void) | undefined;
}

export type Status = 'off' | 'dynamic' | 'native' | 'filter' | 'already-dark' | 'locked';

export interface StatusReport {
  status: Status;
  host: string;
  /** Main-thread ms Dusk spent on this page, including engines that were stopped. */
  cost: number;
  /** Which of the site's own themes is in use, when status is 'native'. */
  native: 'media' | 'toggle' | null;
  /** Text checked and corrected for contrast; null when the check doesn't apply here. */
  contrast: { checked: number; fixed: number } | null;
  /** Whether "Fix a spot" can be used: Dusk is styling this page. */
  canPick: boolean;
  /** Busiest dark-theme hooks and the ones tried and rejected; diagnostics. */
  hooks?: [string, number][];
  rejected?: string[];
}

interface CacheEntry {
  kind: 'dark' | 'transform' | 'native';
  css?: string;
}

const MAX_CACHE_CSS = 1_500_000;

globalThis.__duskTeardown?.();

const isTop = window === window.top;
/** The per-site cache is a record of visited sites; Incognito must leave no trace of it. */
const mayCache = isTop && !chrome.extension.inIncognitoContext;
const cacheKey = 'c:' + location.origin;
const systemDark = matchMedia('(prefers-color-scheme: dark)');

let settings: Settings | null = null;
let mode: Mode = 'off';
let engine: DynamicTheme | FilterTheme | null = null;
let engineKind: Engine | null = null;
let engineDetects = true;
let alreadyDark = false;
let locked = false;
let cache: CacheEntry | null | undefined;
let fix: SiteFix | null = null;
let timeTimer: ReturnType<typeof setTimeout> | undefined;
/** Cost of engines already stopped on this page, plus the content script's own setup. */
let pastCost = 0;
const scriptStart = performance.now();

/** Frames follow the top page's site setting. */
function settingsHost(): string {
  if (isTop) return location.hostname;
  const ancestors = location.ancestorOrigins;
  const top = ancestors?.[ancestors.length - 1];
  try {
    return top ? new URL(top).hostname : location.hostname;
  } catch {
    return location.hostname;
  }
}

function status(): Status {
  if (mode === 'off') return 'off';
  if (locked) return 'locked';
  if (alreadyDark && detecting()) return 'already-dark';
  if (engine instanceof DynamicTheme) return engine.native ? 'native' : 'dynamic';
  return engine ? 'filter' : 'off';
}

/** Whether auto mode should step aside on dark sites; settings may not have loaded yet. */
const detecting = () => mode.startsWith('auto-') && (settings?.detectDark ?? true);

function wantedEngine(): Engine | null {
  if (mode === 'off' || locked) return null;
  if (mode.startsWith('auto-')) return alreadyDark && detecting() ? null : (mode.slice(5) as Engine);
  return mode as Engine;
}

function apply(next: Mode) {
  mode = next;
  const want = wantedEngine();
  if (want === engineKind && detecting() === engineDetects) return;
  if (engine) pastCost += engine.cost;
  engine?.stop();
  engine = null;
  engineKind = want;
  engineDetects = detecting();
  if (!want) return;
  const theme = settings ? themeOf(settings) : DEFAULT_THEME;
  if (want === 'filter') {
    engine = new FilterTheme(theme);
    if (fix) engine.setFix(fix);
    engine.setUserFixes(userCss());
    engine.start();
    return;
  }
  const dyn = new DynamicTheme(
    theme,
    {
      fetchCSS: (url) => chrome.runtime.sendMessage({ type: 'fetch', url }).catch(() => null),
      analyzeImages: (urls) =>
        chrome.runtime
          .sendMessage({ type: 'images', urls, theme: settings ? themeOf(settings) : DEFAULT_THEME })
          .catch(() => null),
      onAlreadyDark: () => {
        if (engine !== dyn) return;
        pastCost += dyn.cost;
        engine = null;
        engineKind = null;
        alreadyDark = true;
      },
    },
    engineDetects,
  );
  engine = dyn;
  if (fix) dyn.setFix(fix);
  if (settings) dyn.setContrast(settings.fixContrast);
  dyn.setUserFixes(userCss());
  dyn.start();
  if (cache?.css && cache.kind !== 'dark') dyn.useCache(cache.css);
}

/** Filter mode has no CSS model to read, so it measures; its sheet is small, so this is cheap. */
function afterLoad() {
  if (engine instanceof FilterTheme && detecting() && engine.measureDark(false)) {
    alreadyDark = true;
    apply(mode);
  }
  if (mayCache) setTimeout(() => requestIdleCallback(saveCache, { timeout: 2000 }), 1000);
}

/** The user's picker fixes for this site. */
const userCss = () => (settings ? userFixCss(settings.userFixes, settingsHost()) : '');

function saveCache() {
  if (settings && !settings.rememberSites) return;
  let entry: CacheEntry | null = null;
  if (alreadyDark) entry = { kind: 'dark' };
  else if (engine instanceof DynamicTheme && engine.documentCss.length < MAX_CACHE_CSS) {
    entry = { kind: engine.native ? 'native' : 'transform', css: engine.documentCss };
  }
  if (!entry || (cache && cache.kind === entry.kind && cache.css === entry.css)) return;
  cache = entry;
  chrome.runtime.sendMessage({ type: 'cache', key: cacheKey, value: entry }).catch(() => {});
}

// Engines started from the flag file, before settings load, use the default palette.
let themeKey = JSON.stringify(DEFAULT_THEME);

function reapply() {
  if (!settings) return;
  const theme = themeOf(settings);
  const key = JSON.stringify(theme);
  // Any setting change lands here; only a palette change is worth regenerating for.
  if (key !== themeKey) {
    themeKey = key;
    engine?.setTheme(theme);
  }
  engine?.setUserFixes(userCss());
  if (engine instanceof DynamicTheme) engine.setContrast(settings.fixContrast);
  apply(modeFor(settings, settingsHost(), systemDark.matches));
  clearTimeout(timeTimer);
  if (settings.automation === 'time') timeTimer = setTimeout(reapply, msToNextBoundary(settings) + 500);
}

function onDomReady() {
  locked = isLocked();
  if (engine instanceof FilterTheme && detecting() && engine.measureDark(false)) alreadyDark = true;
  // A cached "already dark" verdict is cheap to double-check now that the page exists.
  if (alreadyDark && !engine && !renderedDark()) alreadyDark = false;
  apply(mode);
}

async function updateUserFixes(change: (list: [string, 'invert' | 'dim'][]) => [string, 'invert' | 'dim'][]) {
  const host = settingsHost();
  const s = await getSettings();
  const userFixes = { ...s.userFixes, [host]: change([...(s.userFixes[host] ?? [])]) };
  if (!userFixes[host].length) delete userFixes[host];
  await setSettings({ userFixes });
}

function onMessage(msg: { type?: string }, _sender: unknown, respond: (r: unknown) => void) {
  if (!isTop) return;
  if (msg?.type === 'pick') {
    // The picker isn't part of this script; the popup injects picker.js first.
    const startPicker = globalThis.__duskStartPicker;
    if (!engine || !startPicker) return;
    startPicker({
      host: settingsHost(),
      inverted: engine instanceof FilterTheme,
      onFix: (sel, action) => updateUserFixes((list) => [...list.filter(([s]) => s !== sel), [sel, action]]),
      onUndo: (sel) => updateUserFixes((list) => list.filter(([s]) => s !== sel)),
    });
    respond(true);
    return;
  }
  if (msg?.type !== 'status') return;
  const report: StatusReport = {
    status: status(),
    host: location.hostname,
    cost: pastCost + (engine?.cost ?? 0),
    native: engine instanceof DynamicTheme ? engine.nativeKind : null,
    contrast: engine instanceof DynamicTheme ? engine.contrast : null,
    canPick: engine !== null,
    hooks: engine instanceof DynamicTheme ? engine.hookStats : undefined,
    rejected: engine instanceof DynamicTheme ? engine.rejectedHooks : undefined,
  };
  respond(report);
}

async function init() {
  // Flag files are per frame URL; frames wait for settings since they follow the top page.
  const flag = isTop ? globalThis.__dusk : undefined;
  if (flag && !(flag.sys && !systemDark.matches)) apply(flag.mode);

  const cacheRead = mayCache
    ? chrome.storage.local.get(cacheKey).then((v) => (v[cacheKey] as CacheEntry | undefined) ?? null)
    : Promise.resolve(null);
  cacheRead.then((entry) => {
    cache = entry;
    if (entry?.kind === 'dark') {
      alreadyDark = true;
      apply(mode);
    } else if (entry?.css && engine instanceof DynamicTheme) {
      engine.useCache(entry.css);
    }
  });

  chrome.runtime
    .sendMessage({ type: 'fixes', url: location.href })
    .then((f: SiteFix | null) => {
      if (!f) return;
      fix = f;
      if (f.dark && !alreadyDark) {
        alreadyDark = true;
        apply(mode);
      }
      engine?.setFix(f);
    })
    .catch(() => {});

  settings = await getSettings();
  reapply();
}

const onStorage = (_changes: unknown, area: string) => {
  if (area !== 'sync') return;
  getSettings().then((s) => {
    settings = s;
    reapply();
  });
};
const onLoad = () => afterLoad();

chrome.storage.onChanged.addListener(onStorage);
chrome.runtime.onMessage.addListener(onMessage);
systemDark.addEventListener('change', reapply);
window.addEventListener('load', onLoad);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady);
else onDomReady();

globalThis.__duskTeardown = () => {
  engine?.stop();
  clearTimeout(timeTimer);
  systemDark.removeEventListener('change', reapply);
  window.removeEventListener('load', onLoad);
  document.removeEventListener('DOMContentLoaded', onDomReady);
  try {
    chrome.storage.onChanged.removeListener(onStorage);
    chrome.runtime.onMessage.removeListener(onMessage);
  } catch {
    // The old extension context may already be gone.
  }
};

init();

// The script's own synchronous setup counts too.
pastCost += performance.now() - scriptStart;
