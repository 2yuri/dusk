import type { Theme } from './color.ts';
import { FixIndex } from './fixes.ts';
import { analyze, type Verdict } from './images.ts';
import { getSettings, hostOf, msToNextBoundary, setSettings, siteMode, type Mode, type Settings } from './settings.ts';

const ALL = ['http://*/*', 'https://*/*'];
const VALID_HOST = /^[a-z0-9.-]+$/i;
const MAX_CSS_BYTES = 4_000_000;
const MAX_CACHED_ORIGINS = 300;
const TIME_ALARM = 'dusk-time';

const flagFile = (mode: Mode, sys: boolean) => `flags/${mode}${sys ? '-sys' : ''}.js`;
const pattern = (host: string) => `*://${host}/*`;

/**
 * Pages get the content script plus a tiny flag file that sets the site's
 * mode synchronously, so the right engine starts at document_start without
 * waiting on storage. Sites with their own mode get their own registration.
 */
async function register(s: Settings) {
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((e) => e.id) });

  const sys = s.automation === 'system';
  const defaultMode = siteMode({ ...s, siteModes: {} }, '');
  const groups = new Map<Mode, string[]>();
  for (const host of Object.keys(s.siteModes)) {
    const mode = siteMode(s, host);
    if (mode === defaultMode || !VALID_HOST.test(host)) continue;
    groups.set(mode, [...(groups.get(mode) ?? []), pattern(host)]);
  }

  const common = { runAt: 'document_start', allFrames: true, matchOriginAsFallback: true } as const;
  await chrome.scripting.registerContentScripts([
    { id: 'main', matches: ALL, js: ['main.js'], world: 'MAIN', ...common },
    {
      id: 'default',
      matches: ALL,
      excludeMatches: [...groups.values()].flat(),
      js: [flagFile(defaultMode, sys), 'content.js'],
      ...common,
    },
    ...[...groups].map(([mode, matches]) => ({
      id: `site-${mode}`,
      matches,
      js: [flagFile(mode, sys), 'content.js'],
      ...common,
    })),
  ]);

  await chrome.alarms.clear(TIME_ALARM);
  if (s.enabled && s.automation === 'time') {
    chrome.alarms.create(TIME_ALARM, { when: Date.now() + msToNextBoundary(s) + 1000 });
  }
}

let queue = Promise.resolve();
function reconcile() {
  queue = queue.then(async () => register(await getSettings())).catch(console.error);
}

/** Tabs open before install have no content script yet. */
async function injectIntoOpenTabs() {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !hostOf(tab.url)) continue;
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, files: ['main.js'], world: 'MAIN' })
      .then(() => chrome.scripting.executeScript({ target, files: ['content.js'] }))
      .catch(() => {});
  }
}

const cssCache = new Map<string, string | null>();

/** Cross-origin stylesheets the page can't read, fetched with the extension's host permission. */
async function fetchCSS(url: string): Promise<string | null> {
  if (!/^https?:/i.test(url)) return null;
  if (cssCache.has(url)) return cssCache.get(url)!;
  let text: string | null = null;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (res.ok) {
      text = await res.text();
      if (text.length > MAX_CSS_BYTES) text = null;
    }
  } catch {
    text = null;
  }
  cssCache.set(url, text);
  if (cssCache.size > 200) cssCache.delete(cssCache.keys().next().value!);
  return text;
}

/** Generated CSS per origin, so repeat visits are dark before any stylesheet is parsed. */
async function putCache(key: string, value: unknown) {
  const { cacheIndex = {} } = (await chrome.storage.local.get('cacheIndex')) as { cacheIndex?: Record<string, number> };
  cacheIndex[key] = Date.now();
  const keys = Object.keys(cacheIndex);
  const evict: string[] = [];
  if (keys.length > MAX_CACHED_ORIGINS) {
    keys.sort((a, b) => cacheIndex[a] - cacheIndex[b]);
    for (const k of keys.slice(0, keys.length - MAX_CACHED_ORIGINS)) {
      evict.push(k);
      delete cacheIndex[k];
    }
  }
  if (evict.length) await chrome.storage.local.remove(evict);
  await chrome.storage.local.set({ [key]: value, cacheIndex });
}

const verdicts = new Map<string, Promise<Verdict>>();
const IMAGE_CONCURRENCY = 4;

/** Image verdicts depend on the palette, so the theme is part of the key. */
async function analyzeImages(urls: string[], theme: Theme): Promise<Verdict[]> {
  const prefix = JSON.stringify(theme);
  const out: Verdict[] = new Array(urls.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      const key = prefix + urls[i];
      let v = verdicts.get(key);
      if (!v) {
        verdicts.set(key, (v = analyze(urls[i], theme)));
        if (verdicts.size > 2000) verdicts.delete(verdicts.keys().next().value!);
      }
      out[i] = await v;
    }
  };
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
  return out;
}

let fixIndex: Promise<FixIndex> | undefined;

/** Loaded on first use per worker lifetime; pages only ever receive their own entry. */
function fixesFor(url: string) {
  fixIndex ??= fetch(chrome.runtime.getURL('fixes.json'))
    .then((r) => r.json())
    .then((raw) => new FixIndex(raw));
  return fixIndex.then((index) => index.lookup(url));
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'images' && Array.isArray(msg.urls)) {
    analyzeImages(msg.urls.slice(0, 400).map(String), msg.theme).then(respond, () => respond(null));
    return true;
  }
  if (msg?.type === 'fixes') {
    fixesFor(String(msg.url)).then(respond, () => respond(null));
    return true;
  }
  if (msg?.type === 'fetch') {
    fetchCSS(String(msg.url)).then(respond);
    return true;
  }
  // Belt and braces: never store anything sent from an Incognito tab.
  if (msg?.type === 'cache' && !sender.tab?.incognito && typeof msg.key === 'string' && msg.key.startsWith('c:')) {
    putCache(msg.key, msg.value);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const s = await getSettings();
  if (command === 'toggle-global') {
    await setSettings({ enabled: !s.enabled });
  } else if (command === 'toggle-site') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = hostOf(tab?.url);
    if (!host) return;
    const siteModes = { ...s.siteModes };
    if (siteModes[host] === 'off') delete siteModes[host];
    else siteModes[host] = 'off';
    await setSettings({ siteModes });
  }
});

chrome.alarms.onAlarm.addListener((a) => a.name === TIME_ALARM && reconcile());
chrome.storage.onChanged.addListener((_c, area) => area === 'sync' && reconcile());
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(() => {
  reconcile();
  injectIntoOpenTabs();
});
