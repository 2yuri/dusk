import { DEFAULT_THEME, modify, parseColor, serialize, type Role } from './color.ts';
import { DEFAULTS, getSettings, hostOf, setSettings, themeOf, type FixAction, type Settings, type SiteMode, type UserFixes } from './settings.ts';
import { renderIcons, setIcon } from './ui/icons.ts';
import { commandKeys, debounce, keyCaps, paintRange } from './ui/shared.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SLIDERS = ['brightness', 'contrast', 'sepia', 'grayscale'] as const;
const SITE_MODES: SiteMode[] = ['dynamic', 'filter', 'off'];
const MODE_LABEL: Record<SiteMode, string> = { dynamic: 'Dynamic', filter: 'Filter', off: 'Off' };

/** A plain light page, run through the same transform pages get. */
const PREVIEW: Record<string, [color: string, role: Role, prop: 'color' | 'backgroundColor' | 'borderColor'][]> = {
  root: [['#ffffff', 'bg', 'backgroundColor']],
  muted: [['#8a8a8a', 'fg', 'color']],
  title: [['#111111', 'fg', 'color']],
  body: [['#3a3a3a', 'fg', 'color']],
  callout: [
    ['#f4f4f5', 'bg', 'backgroundColor'],
    ['#e4e4e7', 'bd', 'borderColor'],
    ['#18181b', 'fg', 'color'],
  ],
  link: [['#2563eb', 'fg', 'color']],
};

let s: Settings;
let siteFilter = '';

function save(patch: Partial<Settings>) {
  s = { ...s, ...patch };
  render();
  return setSettings(patch);
}
const saveSoon = debounce((patch: Partial<Settings>) => setSettings(patch), 250);
/** Sliders and pickers update the page at once and write storage when the hand rests. */
function saveLive(patch: Partial<Settings>) {
  s = { ...s, ...patch };
  render();
  saveSoon(patch);
}

function renderPreview() {
  const theme = themeOf(s);
  const paint = (el: HTMLElement, key: string) => {
    for (const [color, role, prop] of PREVIEW[key]) el.style[prop] = serialize(modify(parseColor(color)!, role, theme));
  };
  const preview = $('preview');
  paint(preview, 'root');
  for (const el of preview.querySelectorAll<HTMLElement>('[data-role]')) paint(el, el.dataset.role!);
}

function renderSites() {
  const list = $('siteList');
  const entries = Object.entries(s.siteModes).sort(([a], [b]) => a.localeCompare(b));
  const shown = entries.filter(([h]) => h.includes(siteFilter.trim().toLowerCase()));
  $<HTMLInputElement>('siteSearch').placeholder = `Filter ${entries.length} ${entries.length === 1 ? 'site' : 'sites'}`;
  list.replaceChildren();
  if (!entries.length || !shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('strong');
    const text = document.createElement('span');
    if (!entries.length) {
      title.textContent = 'No sites yet';
      text.textContent = 'Pick a mode for a site from the toolbar popup, or add one here. Every other site uses the default engine.';
    } else {
      title.textContent = `No sites match “${siteFilter.trim()}”`;
      text.textContent = 'Clear the filter to see all of them.';
    }
    empty.append(title, text);
    list.append(empty);
    return;
  }
  for (const [host, mode] of shown) {
    const row = document.createElement('div');
    row.className = 'site-row';
    const name = document.createElement('span');
    name.className = 'host';
    name.textContent = host;
    const tag = document.createElement('select');
    tag.className = 'tag';
    tag.setAttribute('aria-label', `Mode for ${host}`);
    for (const m of SITE_MODES) tag.add(new Option(MODE_LABEL[m], m, false, m === mode));
    tag.onchange = () => save({ siteModes: { ...s.siteModes, [host]: tag.value as SiteMode } });
    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = `Forget ${host}`;
    remove.setAttribute('aria-label', `Forget ${host}`);
    const x = document.createElement('span');
    x.className = 'icon';
    setIcon(x, 'x');
    remove.append(x);
    remove.onclick = () => {
      const siteModes = { ...s.siteModes };
      delete siteModes[host];
      save({ siteModes });
    };
    row.append(name, tag, remove);
    list.append(row);
  }
}

function renderFixes() {
  const list = $('fixList');
  const hosts = Object.keys(s.userFixes).sort();
  $<HTMLButtonElement>('copyFixes').disabled = !hosts.length;
  list.replaceChildren();
  if (!hosts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.append(
      Object.assign(document.createElement('strong'), { textContent: 'No fixes yet' }),
      Object.assign(document.createElement('span'), { textContent: 'If a logo disappears or an image glares, open the popup on that page and use Fix a spot.' }),
    );
    list.append(empty);
    return;
  }
  for (const host of hosts) {
    const group = document.createElement('div');
    group.className = 'fix-group';
    group.append(Object.assign(document.createElement('strong'), { textContent: host }));
    for (const [sel, action] of s.userFixes[host]) {
      const row = document.createElement('div');
      row.className = 'site-row';
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.setAttribute('aria-label', `Remove the fix for ${sel} on ${host}`);
      const x = document.createElement('span');
      x.className = 'icon';
      setIcon(x, 'x');
      remove.append(x);
      remove.onclick = () => {
        const userFixes = { ...s.userFixes, [host]: s.userFixes[host].filter(([sl]) => sl !== sel) };
        if (!userFixes[host].length) delete userFixes[host];
        save({ userFixes });
      };
      row.append(
        Object.assign(document.createElement('span'), { className: 'host', textContent: sel }),
        Object.assign(document.createElement('span'), { className: 'tag', textContent: action === 'invert' ? 'Invert' : 'Dim' }),
        remove,
      );
      group.append(row);
    }
    list.append(group);
  }
}

/** The fixes in Dark Reader's config format, ready to paste into its dynamic-theme-fixes.config. */
function darkReaderFormat(fixes: UserFixes): string {
  return Object.keys(fixes)
    .sort()
    .map((host) => {
      const invert = fixes[host].filter(([, a]) => a === 'invert').map(([sel]) => sel);
      const dim = fixes[host].filter(([, a]) => a === 'dim').map(([sel]) => sel);
      let out = `${host}\n`;
      if (invert.length) out += `\nINVERT\n${invert.join('\n')}\n`;
      if (dim.length) out += `\nCSS\n${dim.join(',\n')} {\n    filter: brightness(72%) !important;\n}\n`;
      return out;
    })
    .join('\n================================\n\n');
}

function render() {
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('fixContrast').checked = s.fixContrast;
  $<HTMLInputElement>('rememberSites').checked = s.rememberSites;
  $<HTMLInputElement>('detectDark').checked = s.detectDark;
  $<HTMLInputElement>('onlyListed').checked = s.onlyListed;
  for (const b of $('engine').querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.engine === s.defaultEngine));
  }
  for (const k of SLIDERS) {
    const input = $<HTMLInputElement>(k);
    if (document.activeElement !== input) input.value = String(s[k]);
    paintRange(input);
    (input.nextElementSibling as HTMLOutputElement).value = String(s[k]);
  }
  $<HTMLInputElement>('bgColor').value = s.bgColor;
  $<HTMLInputElement>('fgColor').value = s.fgColor;
  $('bgHex').textContent = s.bgColor;
  $('fgHex').textContent = s.fgColor;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="automation"]')) r.checked = r.value === s.automation;
  $<HTMLInputElement>('timeFrom').value = s.timeFrom;
  $<HTMLInputElement>('timeTo').value = s.timeTo;
  renderPreview();
  renderSites();
  renderFixes();
}

// --- Sites: adding -------------------------------------------------------

function normalizeHost(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (!v) return null;
  const host = hostOf(/^[a-z][\w+.-]*:\/\//.test(v) ? v : `https://${v}`);
  return host && (host.includes('.') || host === 'localhost') ? host : null;
}

function showAdd(open: boolean) {
  $('newSite').hidden = !open;
  $('siteError').hidden = true;
  if (open) {
    $<HTMLInputElement>('newHost').value = '';
    $<HTMLInputElement>('newHost').focus();
  }
}

// --- About ---------------------------------------------------------------

async function sizeOf(path: string): Promise<number> {
  return (await (await fetch(chrome.runtime.getURL(path))).blob()).size;
}

async function renderAbout() {
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = manifest.version;
  $('aboutLine').textContent = `Dusk ${manifest.version} · MIT · site fixes from Dark Reader's community configs (MIT).`;
  const bytes = (await sizeOf('content.js')) + (await sizeOf('main.js'));
  $('statScript').textContent = `${Math.round(bytes / 1024)} KB`;
  const fixes = (await (await fetch(chrome.runtime.getURL('fixes.json'))).json()) as { dyn: unknown[] };
  $('statFixes').textContent = (Math.floor(fixes.dyn.length / 100) * 100).toLocaleString('en-US') + '+';
  await renderCache();
}

async function cacheKeys(): Promise<string[]> {
  return Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('c:'));
}

async function renderCache() {
  const keys = await cacheKeys();
  const bytes = keys.length ? await chrome.storage.local.getBytesInUse(keys) : 0;
  const size = bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
  $('cacheInfo').textContent = `Keeps the CSS Dusk generated for up to 300 sites on this computer, so repeat visits go dark instantly. Never in Incognito, never sent anywhere. ${keys.length} ${keys.length === 1 ? 'site' : 'sites'} · ${size}.`;
  $<HTMLButtonElement>('clearCache').disabled = !keys.length;
}

/** Only known keys with the right types survive an import. */
function sanitize(raw: unknown): Partial<Settings> | null {
  const src = (raw as { settings?: unknown })?.settings ?? raw;
  if (!src || typeof src !== 'object') return null;
  const out: Partial<Settings> = {};
  for (const [k, def] of Object.entries(DEFAULTS) as [keyof Settings, unknown][]) {
    const v = (src as Record<string, unknown>)[k];
    if (v === undefined || typeof v !== typeof def) continue;
    if (k === 'userFixes') {
      const fixes: UserFixes = {};
      for (const [h, list] of Object.entries(v as object)) {
        const host = normalizeHost(h);
        if (!host || !Array.isArray(list)) continue;
        const valid = list.filter(
          (f): f is [string, FixAction] =>
            Array.isArray(f) && typeof f[0] === 'string' && f[0].length < 500 && (f[1] === 'invert' || f[1] === 'dim'),
        );
        if (valid.length) fixes[host] = valid;
      }
      out.userFixes = fixes;
    } else if (k === 'siteModes') {
      const modes: Record<string, SiteMode> = {};
      for (const [h, m] of Object.entries(v as object)) {
        const host = normalizeHost(h);
        if (host && SITE_MODES.includes(m as SiteMode)) modes[host] = m as SiteMode;
      }
      out.siteModes = modes;
    } else {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

async function main() {
  renderIcons();
  s = await getSettings();
  render();

  // General
  $<HTMLInputElement>('enabled').onchange = (e) => save({ enabled: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('detectDark').onchange = (e) => save({ detectDark: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('onlyListed').onchange = (e) => save({ onlyListed: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('fixContrast').onchange = (e) => save({ fixContrast: (e.target as HTMLInputElement).checked });
  $<HTMLInputElement>('rememberSites').onchange = async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    await save({ rememberSites: on });
    // Turning it off means forgetting, too.
    if (!on) await chrome.storage.local.remove([...(await cacheKeys()), 'cacheIndex']);
    renderCache();
  };
  $('copyFixes').onclick = async () => {
    await navigator.clipboard.writeText(darkReaderFormat(s.userFixes));
    const label = $('copyFixes').lastChild!;
    label.textContent = 'Copied';
    setTimeout(() => (label.textContent = 'Copy as Dark Reader fix'), 1500);
  };
  for (const b of $('engine').querySelectorAll<HTMLButtonElement>('button')) {
    b.onclick = () => save({ defaultEngine: b.dataset.engine as Settings['defaultEngine'] });
  }

  // Appearance
  for (const k of SLIDERS) $<HTMLInputElement>(k).oninput = (e) => saveLive({ [k]: Number((e.target as HTMLInputElement).value) });
  for (const k of ['bgColor', 'fgColor'] as const) $<HTMLInputElement>(k).oninput = (e) => saveLive({ [k]: (e.target as HTMLInputElement).value });
  $('resetTheme').onclick = () => save({ ...DEFAULT_THEME });

  // Schedule
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="automation"]')) {
    r.onchange = () => save({ automation: r.value as Settings['automation'] });
  }
  $<HTMLInputElement>('timeFrom').onchange = (e) => save({ timeFrom: (e.target as HTMLInputElement).value, automation: 'time' });
  $<HTMLInputElement>('timeTo').onchange = (e) => save({ timeTo: (e.target as HTMLInputElement).value, automation: 'time' });

  // Sites
  $<HTMLInputElement>('siteSearch').oninput = (e) => {
    siteFilter = (e.target as HTMLInputElement).value;
    renderSites();
  };
  $('addSite').onclick = () => showAdd(true);
  $('cancelSite').onclick = () => showAdd(false);
  $('newSite').onsubmit = (e) => {
    e.preventDefault();
    const host = normalizeHost($<HTMLInputElement>('newHost').value);
    if (!host) {
      $('siteError').textContent = 'Enter a site like example.com or a full address.';
      $('siteError').hidden = false;
      return;
    }
    showAdd(false);
    save({ siteModes: { ...s.siteModes, [host]: $<HTMLSelectElement>('newMode').value as SiteMode } });
  };
  $('newSite').onkeydown = (e) => {
    if (e.key === 'Escape') showAdd(false);
  };

  // Shortcuts
  const keys = await commandKeys();
  for (const el of document.querySelectorAll('.globalKeys')) el.textContent = keys['toggle-global'] || '⌥⇧D';
  const list = $('shortcutList');
  for (const c of await chrome.commands.getAll()) {
    if (!c.name || c.name.startsWith('_')) continue;
    const row = document.createElement('div');
    row.className = 'row shortcut';
    const label = document.createElement('span');
    label.textContent = c.description ?? c.name;
    const caps = document.createElement('span');
    caps.className = 'keys';
    const shortcut = keys[c.name];
    if (shortcut) for (const k of keyCaps(shortcut)) caps.append(Object.assign(document.createElement('kbd'), { textContent: k }));
    else caps.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Not set' }));
    row.append(label, caps);
    list.append(row);
  }
  $('openShortcuts').onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };

  // About
  renderAbout();
  $('clearCache').onclick = async () => {
    await chrome.storage.local.remove([...(await cacheKeys()), 'cacheIndex']);
    renderCache();
  };
  $('exportSettings').onclick = () => {
    const blob = new Blob([JSON.stringify({ dusk: 1, settings: s }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'dusk-settings.json' });
    a.click();
    URL.revokeObjectURL(a.href);
    $('backupNote').textContent = 'Saved dusk-settings.json';
  };
  $('importSettings').onclick = () => $('importFile').click();
  $<HTMLInputElement>('importFile').onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    let patch: Partial<Settings> | null = null;
    try {
      patch = sanitize(JSON.parse(await file.text()));
    } catch {
      patch = null;
    }
    if (!patch) {
      $('backupNote').textContent = `${file.name} isn't a Dusk settings file.`;
      return;
    }
    await save(patch);
    const sites = Object.keys(patch.siteModes ?? {}).length;
    $('backupNote').textContent = `Imported ${file.name}${sites ? `, ${sites} ${sites === 1 ? 'site' : 'sites'}` : ''}.`;
    (e.target as HTMLInputElement).value = '';
  };

  // Sidebar follows the section in view.
  const links = new Map([...document.querySelectorAll<HTMLAnchorElement>('nav a')].map((a) => [a.hash.slice(1), a]));
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      for (const [id, a] of links) a.classList.toggle('active', id === visible.target.id);
    },
    { rootMargin: '-10% 0px -60% 0px' },
  );
  for (const sec of document.querySelectorAll('main > section')) observer.observe(sec);
  links.get(location.hash.slice(1) || 'general')?.classList.add('active');

  // Other pages (the popup, another options tab) change settings too.
  chrome.storage.onChanged.addListener(async (_c, area) => {
    if (area === 'sync') {
      s = await getSettings();
      render();
    } else if (area === 'local') {
      renderCache();
    }
  });
}

main();
