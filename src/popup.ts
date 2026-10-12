import { DEFAULT_THEME } from './color.ts';
import type { Status, StatusReport } from './content.ts';
import { getSettings, hostOf, setSettings, type Settings, type SiteMode } from './settings.ts';
import { renderIcons, setIcon } from './ui/icons.ts';
import { commandKeys, debounce, paintRange } from './ui/shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SLIDERS = ['brightness', 'contrast', 'sepia', 'grayscale'] as const;

const STATUS: Record<Status, string> = {
  off: 'Off on this site',
  dynamic: 'Dark mode on, colors rewritten',
  native: "Using the site's own dark theme",
  filter: 'Dark mode on, page inverted',
  'already-dark': 'Already dark, left as is',
  locked: 'The site asked to stay as designed',
};

const HINTS: Record<SiteMode | 'auto', string> = {
  auto: 'Auto rewrites colors, and steps aside on sites that are already dark.',
  dynamic: "Dynamic rewrites this site's colors, even when it looks dark already.",
  filter: 'Filter inverts this site on the GPU. The cheapest mode, less faithful.',
  off: 'Dusk leaves this site exactly as designed.',
};

/** Pages no extension may script, with the names the design uses for them. */
function restrictedName(url: string | undefined): string {
  if (!url) return 'This page';
  if (/^(chrome|edge|brave):\/\/settings/.test(url)) return 'Chrome settings';
  if (/^(chrome|edge|brave):\/\/extensions/.test(url)) return 'Extensions';
  if (/chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(url)) return 'Chrome Web Store';
  if (/^(chrome|edge|brave):\/\/newtab/.test(url)) return 'New tab';
  return 'This page';
}

let s: Settings;
let host: string | null = null;
let tab: chrome.tabs.Tab | undefined;
let status: Status | 'unreachable' | null = null;
let report: StatusReport | null = null;

async function readStatus() {
  if (tab?.id == null || !host) return;
  try {
    report = ((await chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 })) as StatusReport | undefined) ?? null;
    status = report?.status ?? 'unreachable';
  } catch {
    status = 'unreachable';
  }
}

function render() {
  const mode = host ? (s.siteModes[host] ?? 'auto') : 'auto';
  const off = !s.enabled;
  const locked = status === 'locked';

  $<HTMLInputElement>('enabled').checked = s.enabled;
  $('enabledLabel').textContent = off ? 'Off everywhere' : 'On everywhere';
  $('offBanner').hidden = !off;
  for (const id of ['site', 'adjust']) $(id).classList.toggle('dim', off);

  // Site line
  const fav = $('favicon');
  if (!host) {
    fav.replaceChildren(icon('lock'));
    $('host').textContent = restrictedName(tab?.url);
  } else if (locked) {
    fav.replaceChildren(icon('shield-check'));
    $('host').textContent = host;
  } else {
    if (!fav.querySelector('img')) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(tab!.url!)}&size=32`);
      img.onerror = () => fav.replaceChildren(icon('globe'));
      fav.replaceChildren(img);
    }
    $('host').textContent = host;
  }

  let text: string;
  let on = false;
  if (!host) text = "Extensions can't run on this page";
  else if (off) text = 'Off';
  else if (status === null) text = '';
  else if (status === 'unreachable') text = 'Reload the page to apply';
  else {
    text = STATUS[status];
    on = status === 'dynamic' || status === 'native' || status === 'filter';
  }
  $('status').textContent = text;
  $('dot').classList.toggle('on', on);
  $('darken').hidden = off || status !== 'already-dark';

  // Mode control
  const modes = $('modes');
  modes.classList.toggle('dim', !off && (!host || locked));
  for (const b of modes.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    b.disabled = !host || locked;
  }
  modes.querySelector('[data-mode="auto"]')!.textContent = s.onlyListed ? 'Default' : 'Auto';

  const hint = $('hint');
  hint.hidden = off;
  if (!host) hint.textContent = 'Browser pages and the Chrome Web Store are off-limits to every extension. The settings below still apply everywhere else.';
  else if (locked) hint.textContent = 'It carries a darkreader-lock tag. Dusk always respects it, so no mode applies here.';
  else if (status === 'already-dark' && mode === 'auto') hint.textContent = `${host} ships its own dark design, so Dusk isn't running here. Pick Dynamic or Filter to apply it anyway.`;
  else if (mode === 'auto' && s.onlyListed) hint.textContent = 'Only sites you turn on are darkened. Pick a mode to turn this one on.';
  else hint.textContent = HINTS[mode];

  // This page: what Dusk costs here, whether text reads, and the picker.
  $('strip').hidden = !host;
  $('strip').classList.toggle('dim', off);
  $('cost').textContent = report && !off ? formatMs(report.cost) : '0 ms';
  const contrast = report?.contrast;
  let ctext: string;
  if (off) ctext = 'Off';
  else if (!report || status === 'unreachable') ctext = '—';
  else if (report.status === 'filter') ctext = 'Inverted page';
  // Not checked where the site's own colors are shown, or when the user turned the check off.
  else if (!contrast) ctext = report.native || !report.canPick ? "Site's own colors" : 'Not checked';
  else if (!contrast.checked) ctext = 'Checking…';
  else if (contrast.fixed) ctext = `Fixed ${contrast.fixed} ${contrast.fixed === 1 ? 'text' : 'texts'}`;
  else ctext = 'Text readable';
  $('contrastText').textContent = ctext;
  setIcon($('contrastIcon'), contrast || report?.status === 'filter' ? 'contrast' : 'minus');
  $<HTMLButtonElement>('pick').disabled = off || !report?.canPick;

  // Adjust
  for (const k of SLIDERS) {
    const input = $<HTMLInputElement>(k);
    input.value = String(s[k]);
    paintRange(input);
    (input.nextElementSibling as HTMLOutputElement).value = String(s[k]);
  }
  $<HTMLInputElement>('bgColor').value = s.bgColor;
  $<HTMLInputElement>('fgColor').value = s.fgColor;

}

function formatMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function icon(name: Parameters<typeof setIcon>[1]) {
  const el = document.createElement('span');
  el.className = 'icon';
  setIcon(el, name);
  return el;
}

async function save(patch: Partial<Settings>) {
  s = { ...s, ...patch };
  render();
  await setSettings(patch);
  // Give the page a moment to switch engines, then show what it ended up doing.
  setTimeout(async () => {
    await readStatus();
    render();
  }, 200);
}

function setSiteMode(mode: SiteMode | 'auto') {
  if (!host) return;
  const siteModes = { ...s.siteModes };
  if (mode === 'auto') delete siteModes[host];
  else siteModes[host] = mode;
  save({ siteModes });
}

async function main() {
  renderIcons();
  // `?tab=<id>` points the popup at a given tab; the UI screenshot harness uses it.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  host = hostOf(tab?.url);
  s = await getSettings();
  render();
  await readStatus();
  render();

  const keys = await commandKeys();
  $('shortcuts').textContent = `${keys['toggle-site'] || '—'} this site · ${keys['toggle-global'] || '—'} everywhere`;
  if (keys['toggle-global']) $('globalKeys').textContent = keys['toggle-global'];

  $<HTMLInputElement>('enabled').onchange = (e) => save({ enabled: (e.target as HTMLInputElement).checked });
  for (const b of $('modes').querySelectorAll<HTMLButtonElement>('button')) b.onclick = () => setSiteMode(b.dataset.mode as SiteMode | 'auto');
  $('darken').onclick = () => setSiteMode('dynamic');

  // storage.sync allows about two writes a second, so drags and color picks are coalesced.
  const saveSoon = debounce((patch: Partial<Settings>) => save(patch), 250);
  for (const k of SLIDERS) {
    const input = $<HTMLInputElement>(k);
    input.oninput = () => {
      paintRange(input);
      (input.nextElementSibling as HTMLOutputElement).value = input.value;
      saveSoon({ [k]: Number(input.value) });
    };
  }
  for (const k of ['bgColor', 'fgColor'] as const) $<HTMLInputElement>(k).oninput = (e) => saveSoon({ [k]: (e.target as HTMLInputElement).value });
  $('resetTheme').onclick = () => save({ ...DEFAULT_THEME });
  $('pick').onclick = async () => {
    if (tab?.id == null) return;
    // The picker ships separately so pages don't carry it on every load.
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['picker.js'] }).catch(() => {});
    await chrome.tabs.sendMessage(tab.id, { type: 'pick' }, { frameId: 0 }).catch(() => {});
    window.close();
  };
  $('allSettings').onclick = () => chrome.runtime.openOptionsPage();
}

main();
