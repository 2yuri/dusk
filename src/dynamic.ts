import type { Theme } from './color.ts';
import { ContrastGuard } from './contrast.ts';
import { darkWithout, declaredDark, renderedDark } from './detect.ts';
import { Generator, isDarkMedia, newInfo, scan, scanVars, type RootRule, type SheetInfo } from './generate.ts';
import type { SiteFix } from './fixes.ts';
import { Ctx, DEP_IMAGES, DEP_VARS, declarations, roleOf, varRefs } from './transform.ts';

type Root = Document | ShadowRoot;
type NativeKind = 'media' | 'toggle' | null;

/** A dark-theme hook we set on html/body, and how to take it back. */
interface Toggle {
  key: string;
  el: Element;
  added: boolean;
  /** The attribute's value before we set it (`data-theme="light"`), restored when we let go. */
  prev: string | null;
  restores: number;
  at: number;
  observer: MutationObserver;
}

/** Below this weight a hook is a widget variant, not a theme. Verification catches the rest. */
const TOGGLE_MIN_RULES = 5;
/** Frameworks re-render <html> during hydration; put the hook back this often, this soon, then let the site win. */
const TOGGLE_RESTORES = 3;
const TOGGLE_GUARD_MS = 5000;
/** Minimum time between contrast checks while the page keeps changing. */
const CONTRAST_INTERVAL = 2000;

interface Source {
  /** The readable sheet: the page's own, or our parsed copy of a cross-origin one. */
  sheet: CSSStyleSheet;
  media: string;
  base: string | null;
  dark: boolean;
}

/** Key of one of our sheets: a source sheet it overrides, or a fixed part of the document's overrides. */
type PieceKey = CSSStyleSheet | 'base' | 'cache' | 'fix' | 'user' | 'contrast';

interface Piece {
  sheet: CSSStyleSheet;
  text: string;
}

interface RootState {
  root: Root;
  /** The document's own pieces (base, cache, fix); per-sheet pieces are shared, see `shared`. */
  pieces: Map<PieceKey, Piece>;
  /** Piece keys in cascade order, as of the last pass. */
  order: PieceKey[];
  /** Our sheets to adopt, in cascade order. */
  want: CSSStyleSheet[];
  inline: CSSStyleSheet;
  /** Inline-style and presentation-attribute values seen, keyed by kind + value. */
  inlineRules: Map<string, string>;
  inlineDirty: boolean;
  inlineText: string;
  observer: MutationObserver;
  /** Its sheets may have changed since the last pass. */
  dirty: boolean;
  srcs: Source[];
  /** What we last adopted, so unchanged roots cost nothing per pass. */
  adopted: CSSStyleSheet[] | null;
}

/** A memo is valid while the sheet still has the same rules: same count, same first and last rule objects. */
interface Sig {
  len: number;
  first: CSSRule | undefined;
  last: CSSRule | undefined;
}
function sig(sheet: CSSStyleSheet): Sig {
  const rules = sheet.cssRules;
  return { len: rules.length, first: rules[0], last: rules[rules.length - 1] };
}
function sameSig(a: Sig, b: Sig): boolean {
  return a.len === b.len && a.first === b.first && a.last === b.last;
}

export interface Hooks {
  fetchCSS(url: string): Promise<string | null>;
  /** Background-image verdicts from the background worker, in order. */
  analyzeImages(urls: string[]): Promise<(string | null)[] | null>;
  /** With detection on: the site turned out to be dark already. The engine has stopped itself. */
  onAlreadyDark(): void;
}

const INLINE = '[style],[bgcolor],[fill],[stroke],font[color],body[text]';
const SCAN = `style,link,${INLINE}`;
const ATTRS = ['style', 'bgcolor', 'fill', 'stroke', 'color', 'text', 'media', 'disabled', 'rel', 'href'];
const STYLE_TEXT: MutationObserverInit = { characterData: true, childList: true, subtree: true };
const MAX_INLINE_RULES = 5000;
/** Images analyzed per page; past this, backgrounds are left as they are. */
const MAX_IMAGES = 400;
const FALLBACK_TIMEOUT = 2500;
/** Below this many dark-scheme rules a site's dark CSS is a widget, not a theme. */
const NATIVE_MIN_RULES = 10;

function cssString(v: string): string {
  return `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
}

export class DynamicTheme {
  private roots = new Map<Root, RootState>();
  private ours = new WeakSet<CSSStyleSheet>();
  private fallback = new CSSStyleSheet();
  private fallbackOn = true;
  private ctx!: Ctx;
  private gen!: Generator;
  private probe: Ctx;
  private colorVars = new Set<string>();
  private infoMemo = new WeakMap<CSSStyleSheet, { sig: Sig; info: SheetInfo }>();
  private varsMemo = new WeakMap<CSSStyleSheet, { sig: Sig; vars: [string, string][] }>();
  private textMemo = new WeakMap<CSSStyleSheet, { sig: Sig; native: NativeKind; text: string; deps: number; stamp: number }>();
  /** Every root needs its sheets re-read (CSSOM change we can't attribute, new palette...). */
  private allDirty = true;
  /** Variables per distinct sheet as of the last resolution; web components share sheets across many roots. */
  private varSources = new Map<CSSStyleSheet, [string, string][]>();
  /**
   * Custom properties declared in style attributes. Apps like Outlook set
   * their whole theme this way from script, so these count toward which
   * variables hold colors, same as stylesheet ones.
   */
  private inlineVarDecls: [string, string][] = [];
  private inlineVarSeen = new Set<string>();
  private inlineVarsChanged = false;
  /**
   * One override sheet per source sheet, so a change re-parses only its own
   * overrides. Shared by every root adopting that source: web components
   * reuse one sheet across hundreds of shadow roots, and so do we.
   */
  private shared = new WeakMap<CSSStyleSheet, Piece>();
  private shadowSearch = false;
  private fetched = new Map<string, CSSStyleSheet | null>();
  private fetching = new Set<string>();
  private shadowTags = new Set<string>();
  private scratch = document.createElement('div').style;
  private scheduled = false;
  private running = false;
  private domReady = false;
  private cached: string | null = null;
  private nativeRejected = false;
  private cleanups: (() => void)[] = [];
  private fix: SiteFix | null = null;
  private fixText = '';
  private measured = false;
  private nativeUnverified = false;
  private sheetCount = -1;
  private images = new Map<string, string | null>();
  private imageQueue = new Set<string>();
  /** The site's own dark theme is in use: its `prefers-color-scheme` rules, or a theme behind its own toggle. */
  nativeKind: NativeKind = null;
  private toggle: Toggle | null = null;
  private toggleRejected = new Set<string>();
  /** The busiest hooks seen on the last pass, for the survey and debugging. */
  hookStats: [string, number][] = [];
  get rejectedHooks(): string[] {
    return [...this.toggleRejected];
  }

  get native(): boolean {
    return this.nativeKind !== null;
  }

  /** `detect`: step aside when the site is dark on its own (auto modes). */
  constructor(
    private theme: Theme,
    private hooks: Hooks,
    private detect: boolean,
  ) {
    this.probe = new Ctx(theme, new Set());
    this.ours.add(this.fallback);
  }

  private guard = new ContrastGuard();
  private contrastOn = true;
  private contrastTimer: ReturnType<typeof setTimeout> | undefined;
  private contrastAt = -Infinity;
  private userCss = '';

  /** Text checked and corrected for contrast so far; null when the check doesn't apply. */
  get contrast(): { checked: number; fixed: number } | null {
    if (!this.contrastOn || this.native) return null;
    return { checked: this.guard.checked, fixed: this.guard.fixed };
  }

  setContrast(on: boolean) {
    if (on === this.contrastOn) return;
    this.contrastOn = on;
    if (!on) this.resetContrast();
    else this.queueContrast(0);
  }

  /** Fixes the user made with the picker; they apply in every mode. */
  setUserFixes(css: string) {
    if (css === this.userCss) return;
    this.userCss = css;
    const doc = this.roots.get(document);
    if (doc) doc.dirty = true;
    this.schedule();
  }

  /** Check contrast at the next idle moment, at most every couple of seconds. */
  queueContrast(delay = 300) {
    if (!this.running || !this.contrastOn || this.contrastTimer !== undefined) return;
    const wait = Math.max(delay, this.contrastAt + CONTRAST_INTERVAL - performance.now());
    this.contrastTimer = setTimeout(() => {
      requestIdleCallback(
        () => {
          this.contrastTimer = undefined;
          if (!this.running || !this.contrastOn || this.native || !this.domReady) return;
          this.contrastAt = performance.now();
          if (this.timed(() => this.guard.run())) {
            this.roots.get(document)!.dirty = true;
            this.update();
          }
        },
        { timeout: 1000 },
      );
    }, wait);
  }

  private resetContrast() {
    clearTimeout(this.contrastTimer);
    this.contrastTimer = undefined;
    this.guard.clear();
    const doc = this.roots.get(document);
    if (doc) doc.dirty = true;
    this.schedule();
  }

  /** Main-thread time Dusk's own work took on this page, in ms. */
  cost = 0;
  private timing = 0;

  /** Times the outermost call only, so nested work isn't counted twice. */
  private timed<T>(fn: () => T): T {
    if (this.timing++) {
      try {
        return fn();
      } finally {
        this.timing--;
      }
    }
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.timing--;
      this.cost += performance.now() - t0;
    }
  }

  start() {
    this.timed(() => this.startNow());
  }

  private startNow() {
    this.running = true;
    this.newCtx();
    this.fallback.replaceSync(this.fallbackCss());
    this.addRoot(document);

    const linkSettled = (e: Event) => {
      if ((e.target as Element).localName !== 'link') return;
      this.roots.get(document)!.dirty = true;
      this.schedule();
    };
    this.on(document, 'load', linkSettled, true);
    this.on(document, 'error', linkSettled, true);
    this.on(document, '__dusk_cssom', (e) => {
      const kind = String((e as CustomEvent).detail ?? '');
      const doc = this.roots.get(document)!;
      if (kind.includes('a')) {
        this.adopt(doc, true);
        doc.dirty = true;
      }
      // Rule edits can't be traced to a sheet; memos still hold for sheets that didn't change.
      if (/[idr]/.test(kind)) this.allDirty = true;
      this.schedule();
    });
    // A shadow root's adoptedStyleSheets was reassigned; the event comes from its host.
    this.on(document, '__dusk_adopt', (e) => {
      const host = e.composedPath()[0] as Element;
      const st = host?.shadowRoot && this.roots.get(host.shadowRoot);
      if (!st) return;
      this.adopt(st, true);
      st.dirty = true;
      this.schedule();
    });
    this.on(window, 'load', () => this.queueContrast(200));
    // New text scrolls into range; the check is throttled and runs at idle time.
    this.on(window, 'scroll', () => this.queueContrast(300), true);
    this.on(document, '__dusk_shadow', (e) => {
      for (const tag of String((e as CustomEvent).detail ?? '').split(',')) if (tag) this.shadowTags.add(CSS.escape(tag));
      this.shadowSearch = true;
      this.schedule();
    });

    if (document.readyState === 'loading') {
      this.on(document, 'DOMContentLoaded', () => this.ready());
    } else {
      this.ready();
    }
    this.schedule();
  }

  stop() {
    this.running = false;
    this.dropToggle(false);
    clearTimeout(this.contrastTimer);
    this.guard.clear();
    for (const off of this.cleanups) off();
    this.cleanups = [];
    for (const st of this.roots.values()) {
      st.observer.disconnect();
      st.root.adoptedStyleSheets = st.root.adoptedStyleSheets.filter((s) => !this.ours.has(s));
    }
    this.roots.clear();
  }

  /** Last generated overrides from a previous visit, shown until real ones exist. */
  useCache(css: string) {
    if (this.domReady || !this.running) return;
    this.cached = css;
    this.setFallback(false);
    this.roots.get(document)!.dirty = true;
    this.schedule();
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    // Corrections were computed for the old palette.
    if (this.running) {
      this.resetContrast();
      this.queueContrast(500);
    }
    this.images.clear();
    this.probe = new Ctx(theme, new Set());
    this.fixText = this.fixCss();
    this.fallback.replaceSync(this.fallbackCss());
    this.newCtx();
    this.schedule();
  }

  setFix(fix: SiteFix) {
    this.fix = fix;
    this.fixText = this.fixCss();
    this.newCtx();
    this.schedule();
  }

  /** Native dark CSS was picked but the page still renders light: fall back to rewriting. */
  rejectNative() {
    if (this.nativeKind === 'toggle') this.dropToggle(true);
    else this.nativeRejected = true;
    this.update();
  }

  /** The document's overrides, for the per-origin cache. */
  get documentCss(): string {
    const st = this.roots.get(document);
    if (!st) return '';
    return st.order
      .map((k) => (k === 'cache' ? '' : ((typeof k === 'string' ? st.pieces.get(k) : this.shared.get(k))?.text ?? '')))
      .join('');
  }

  /**
   * Whether the page is dark. With `withOurs` false our sheets are switched
   * off for the measurement, which tells whether the site was dark already.
   */
  measureDark(withOurs: boolean): boolean {
    if (withOurs) return renderedDark();
    return darkWithout([this.fallback, ...[...this.roots.values()].flatMap((st) => st.want)]);
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void, capture = false) {
    target.addEventListener(type, fn, capture);
    this.cleanups.push(() => target.removeEventListener(type, fn, capture));
  }

  private ready() {
    this.timed(() => this.readyNow());
  }

  private readyNow() {
    if (!this.running || this.domReady) return;
    this.domReady = true;
    this.cached = null;
    this.allDirty = true;
    const st = this.roots.get(document)!;
    this.observe(st);
    this.watchStyles(st, document);
    this.scanInline(st, document);
    this.update();
    // Declarative shadow roots never call attachShadow, so find them with a walk, off the critical path.
    const idle = requestIdleCallback(() => this.running && this.walkShadows(document), { timeout: 1000 });
    this.cleanups.push(() => cancelIdleCallback(idle));
    if (!this.running) return;
    this.queueContrast(300);
    // Only when reading the CSS couldn't tell: check the site's dark theme really took.
    if (this.native && this.nativeUnverified && !this.measureDark(true)) this.rejectNative();
    if (this.fetching.size === 0) this.setFallback(false);
    const t = setTimeout(() => this.setFallback(false), FALLBACK_TIMEOUT);
    this.cleanups.push(() => clearTimeout(t));
  }

  private setFallback(on: boolean) {
    if (this.fallbackOn === on) return;
    this.fallbackOn = on;
    const st = this.roots.get(document);
    if (st) this.adopt(st);
  }

  private newCtx() {
    this.allDirty = true;
    this.ctx = new Ctx(this.theme, this.colorVars);
    this.ctx.imageFor = this.imageFor;
    this.gen = new Generator(this.ctx, this.rulesOf);
    this.textMemo = new WeakMap();
    for (const st of this.roots.values()) {
      for (const key of st.inlineRules.keys()) st.inlineRules.set(key, this.inlineCss(key));
      st.inlineDirty = true;
    }
  }

  private invalidate(deps: number) {
    this.allDirty = true;
    this.ctx.invalidate(deps);
    this.gen.invalidate(deps);
    for (const st of this.roots.values()) {
      for (const key of st.inlineRules.keys()) st.inlineRules.set(key, this.inlineCss(key));
      st.inlineDirty = true;
    }
  }

  private imageFor = (url: string): string | null => {
    const known = this.images.get(url);
    if (known !== undefined || this.images.size >= MAX_IMAGES) return known ?? null;
    this.images.set(url, null);
    if (!this.imageQueue.size) setTimeout(() => this.flushImages(), 30);
    this.imageQueue.add(url);
    return null;
  };

  /** Verdicts come back in one batch; only a recolored icon costs a regeneration. */
  private async flushImages() {
    const urls = [...this.imageQueue];
    this.imageQueue.clear();
    const verdicts = await this.hooks.analyzeImages(urls).catch(() => null);
    if (!verdicts || !this.running) return;
    let changed = false;
    urls.forEach((url, i) => {
      if (verdicts[i]) {
        this.images.set(url, verdicts[i]);
        changed = true;
      }
    });
    if (changed) {
      this.invalidate(DEP_IMAGES);
      this.schedule();
    }
  }

  private fallbackCss(): string {
    const bg = this.probe.transform('#fff', 'bg');
    const fg = this.probe.transform('#000', 'fg');
    return `html,body{background-color:${bg}!important;color:${fg}!important;color-scheme:dark!important}`;
  }

  private baseCss(): string {
    if (this.native) return ':root{color-scheme:dark!important}';
    const t = (v: string, role: 'bg' | 'fg') => this.probe.transform(v, role);
    return (
      ':root{color-scheme:dark!important;' +
      // Names Dark Reader's site fixes refer to.
      `--darkreader-neutral-background:${t('#fff', 'bg')};--darkreader-neutral-text:${t('#000', 'fg')};` +
      '--darkreader-selection-background:#005ccc;--darkreader-selection-text:#fff}' +
      `:where(html){background-color:${t('#fff', 'bg')};color:${t('#000', 'fg')}}` +
      `:where(a:link){color:${t('#0000ee', 'fg')}}:where(a:visited){color:${t('#551a8b', 'fg')}}`
    );
  }

  /**
   * Site fixes from Dark Reader's configs. `${color}` templates are run
   * through the transform with the role of the property they sit in, and
   * Dark Reader's variable names are mapped onto ours.
   */
  private fixCss(): string {
    const fix = this.fix;
    if (!fix) return '';
    let css = fix.invert.length
      ? `:is(${fix.invert.join(',')}){filter:invert(100%) hue-rotate(180deg) contrast(90%)!important}`
      : '';
    const roles: Record<string, 'bg' | 'fg' | 'bd'> = { bg: 'bg', background: 'bg', text: 'fg', border: 'bd' };
    css += fix.css
      .replace(/--darkreader-(bg|text|border)--/g, (_, k: string) => `--dusk-${roles[k]}--`)
      .replace(/var\(--darkreader-(background|text|border)-([\da-f]{3,8})\)/gi, (m, k: string, hex: string) =>
        this.probe.transform('#' + hex, roles[k]) ?? m,
      )
      .replace(/\$\{([^}]*)\}/g, (_, color: string, offset: number, all: string) => {
        // The property this template sits in: back up to the start of the declaration.
        const start = Math.max(all.lastIndexOf(';', offset), all.lastIndexOf('{', offset), all.lastIndexOf('}', offset)) + 1;
        const prop = all.slice(start, all.indexOf(':', start)).trim();
        return this.probe.transform(color.trim(), roleOf(prop) || 'fg') ?? color;
      });
    return css;
  }

  schedule = () => {
    if (this.scheduled || !this.running) return;
    this.scheduled = true;
    if (document.hidden) setTimeout(() => this.update(), 50);
    else requestAnimationFrame(() => this.update());
  };

  // --- sheets -------------------------------------------------------------

  private rulesOf = (sheet: CSSStyleSheet): CSSRuleList | null => this.readable(sheet)?.cssRules ?? null;

  /** The sheet itself when readable; for cross-origin sheets, a copy fetched through the background worker. */
  private readable(sheet: CSSStyleSheet): CSSStyleSheet | null {
    try {
      if (sheet.cssRules) return sheet;
    } catch {
      // Cross-origin without CORS.
    }
    const href = sheet.href;
    if (!href) return null;
    const got = this.fetched.get(href);
    if (got !== undefined) return got;
    if (!this.fetching.has(href)) {
      this.fetching.add(href);
      this.hooks.fetchCSS(href).then((text) => {
        let parsed: CSSStyleSheet | null = null;
        if (text != null) {
          try {
            parsed = new CSSStyleSheet({ baseURL: href });
            parsed.replaceSync(text);
          } catch {
            parsed = null;
          }
        }
        this.fetched.set(href, parsed);
        this.fetching.delete(href);
        // Could belong to any root (an @import, a shadow root's <link>).
        this.allDirty = true;
        if (this.domReady && this.fetching.size === 0) this.setFallback(false);
        this.schedule();
      });
    }
    return null;
  }

  private sources(root: Root): Source[] {
    const out: Source[] = [];
    const add = (sheet: CSSStyleSheet) => {
      if (sheet.disabled || this.ours.has(sheet)) return;
      const readable = this.readable(sheet);
      if (!readable) return;
      const media = sheet.media.mediaText;
      out.push({ sheet: readable, media, base: sheet.href, dark: isDarkMedia(media) });
    };
    for (const sheet of root.styleSheets) add(sheet);
    for (const sheet of root.adoptedStyleSheets) add(sheet);
    return out;
  }

  private info(src: Source): SheetInfo {
    const now = sig(src.sheet);
    const m = this.infoMemo.get(src.sheet);
    if (m && sameSig(m.sig, now)) return m.info;
    const info = newInfo();
    scan(src.sheet.cssRules, this.rulesOf, info, src.dark, src.media && src.media !== 'all' ? [src.media] : []);
    this.infoMemo.set(src.sheet, { sig: now, info });
    return info;
  }

  private vars(src: Source): [string, string][] {
    const now = sig(src.sheet);
    const m = this.varsMemo.get(src.sheet);
    if (m && sameSig(m.sig, now)) return m.vars;
    const vars: [string, string][] = [];
    scanVars(src.sheet.cssRules, this.rulesOf, vars);
    this.varsMemo.set(src.sheet, { sig: now, vars });
    return vars;
  }

  private sheetText(src: Source): string {
    const now = sig(src.sheet);
    const m = this.textMemo.get(src.sheet);
    if (m && sameSig(m.sig, now) && m.native === this.nativeKind && m.stamp === this.gen.stamp(m.deps)) return m.text;
    // With a toggle theme the site's own CSS does everything.
    if (this.nativeKind === 'toggle') return '';
    this.ctx.base = src.base;
    let [text, deps] = this.gen.tracked(() =>
      this.native ? this.gen.native(src.sheet.cssRules, src.dark) : this.gen.list(src.sheet.cssRules),
    );
    this.ctx.base = null;
    if (text && src.media && src.media !== 'all' && !(this.native && src.dark)) text = `@media ${src.media}{${text}}`;
    this.textMemo.set(src.sheet, { sig: now, native: this.nativeKind, text, deps, stamp: this.gen.stamp(deps) });
    return text;
  }

  /** Custom properties holding colors, including ones that alias other color properties. */
  private resolveColorVars(vars: [string, string][]): Set<string> {
    const found = new Set<string>();
    const pending: [string, string[]][] = [];
    for (const [name, value] of vars) {
      if (found.has(name)) continue;
      if (this.probe.isColorish(value)) found.add(name);
      else if (value.includes('var(')) pending.push([name, varRefs(value)]);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [name, refs] of pending) {
        if (!found.has(name) && refs.some((r) => found.has(r))) {
          found.add(name);
          changed = true;
        }
      }
    }
    return found;
  }

  private update() {
    this.timed(() => this.updateNow());
  }

  private updateNow() {
    this.scheduled = false;
    if (!this.running) return;
    if (this.shadowSearch) {
      this.shadowSearch = false;
      for (const root of [...this.roots.keys()]) this.findShadows(root);
    }

    // Only roots whose sheets may have changed are re-read; pages with hundreds of
    // web components would otherwise pay for every root on every pass.
    const all = this.allDirty;
    this.allDirty = false;
    let regen: RootState[] = [];
    let rootsGone = false;
    for (const st of [...this.roots.values()]) {
      if (st.root !== document && !(st.root as ShadowRoot).host.isConnected) {
        st.observer.disconnect();
        this.roots.delete(st.root);
        rootsGone = true;
        continue;
      }
      if (all || st.dirty) {
        st.dirty = false;
        st.srcs = this.sources(st.root);
        regen.push(st);
      }
    }
    const doc = this.roots.get(document)!;

    // Page-level facts come from the document's own sheets.
    const rootDecls: RootRule[] = [];
    const hooks: Record<string, number> = {};
    let darkRules = 0;
    let darkRoot = false;
    for (const src of doc.srcs) {
      const info = this.info(src);
      for (const d of info.root) rootDecls.push(d);
      for (const [k, n] of Object.entries(info.hooks)) hooks[k] = (hooks[k] ?? 0) + n;
      darkRules += info.darkRules;
      darkRoot ||= info.darkRoot;
    }

    // Once our hook is on, the page reads as dark because of us; don't mistake that for the site's design.
    if (this.detect && this.domReady && !this.toggle && this.isAlreadyDark(rootDecls)) {
      this.stop();
      this.hooks.onAlreadyDark();
      return;
    }

    let kind: NativeKind = null;
    if (!this.nativeRejected && darkRules >= NATIVE_MIN_RULES && darkRoot) {
      // Dark rules can hang off a class the page doesn't have (Wikipedia); read whether they'd apply.
      const works = document.body ? declaredDark(rootDecls, true) : null;
      if (works === false) this.nativeRejected = true;
      else {
        kind = 'media';
        this.nativeUnverified = works === null;
      }
    }
    this.hookStats = Object.entries(hooks).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!kind) kind = this.tryToggle(hooks, rootDecls) ? 'toggle' : null;
    if (kind !== 'toggle') this.dropToggle(false);
    if (kind !== this.nativeKind) {
      // Inline rules are skipped in native mode, so they need rebuilding either way.
      this.nativeKind = kind;
      // The site's own theme is the designer's call; corrections made for our palette no longer apply.
      if (kind) this.guard.clear();
      for (const st of this.roots.values()) st.inlineDirty = true;
      regen = [...this.roots.values()];
    }

    // With the site's own dark theme nothing is rewritten, so its variables don't need reading.
    if (!this.native && (regen.length || rootsGone || this.inlineVarsChanged)) {
      const next = new Map<CSSStyleSheet, [string, string][]>();
      let changed = this.inlineVarsChanged;
      this.inlineVarsChanged = false;
      for (const st of this.roots.values()) {
        for (const src of st.srcs) {
          if (next.has(src.sheet)) continue;
          const v = this.vars(src);
          next.set(src.sheet, v);
          if (this.varSources.get(src.sheet) !== v) changed = true;
        }
      }
      const colorVars =
        changed || next.size !== this.varSources.size
          ? this.resolveColorVars([...next.values()].flat().concat(this.inlineVarDecls))
          : this.colorVars;
      this.varSources = next;
      if (colorVars.size !== this.colorVars.size || [...colorVars].some((v) => !this.colorVars.has(v))) {
        // Sheets arrive in waves, each adding variables: redo only output that involved variables.
        this.colorVars = colorVars;
        this.ctx.setColorVars(colorVars);
        this.invalidate(DEP_VARS);
        this.allDirty = false;
        regen = [...this.roots.values()];
      }
    }

    for (const st of regen) {
      const isDoc = st.root === document;
      const order: PieceKey[] = [];
      const want: CSSStyleSheet[] = [];
      const put = (key: PieceKey, text: string) => {
        if (!text) return;
        const own = typeof key === 'string';
        let piece = own ? st.pieces.get(key) : this.shared.get(key);
        if (!piece) {
          piece = { sheet: new CSSStyleSheet(), text: '' };
          this.ours.add(piece.sheet);
          if (own) st.pieces.set(key, piece);
          else this.shared.set(key, piece);
        }
        if (piece.text !== text) {
          piece.text = text;
          piece.sheet.replaceSync(text);
        }
        order.push(key);
        want.push(piece.sheet);
      };
      if (isDoc) put('base', this.baseCss());
      if (isDoc && this.cached) put('cache', this.cached);
      for (const src of st.srcs) put(src.sheet, this.sheetText(src));
      if (isDoc && !this.native) put('fix', this.fixText);
      if (isDoc) put('user', this.userCss);
      if (isDoc && !this.native) put('contrast', this.guard.css);
      const used = new Set(order);
      for (const key of st.pieces.keys()) if (!used.has(key)) st.pieces.delete(key);
      want.push(st.inline);
      st.order = order;
      st.want = want;
    }

    for (const st of this.roots.values()) {
      if (st.inlineDirty) {
        st.inlineDirty = false;
        if (st.inlineRules.size > MAX_INLINE_RULES) {
          st.inlineRules.clear();
          this.scanInline(st, st.root);
        }
        const inline = this.native ? '' : [...st.inlineRules.values()].join('');
        if (inline !== st.inlineText) {
          st.inlineText = inline;
          st.inline.replaceSync(inline);
        }
      }
    }
    for (const st of regen) this.adopt(st);
  }

  /**
   * A dark theme the site ships behind its own toggle: set the hook its CSS
   * uses most and keep it if the page then reads as dark. Nothing is written
   * to the site's storage, so the site is untouched once Dusk is off.
   */
  private tryToggle(hooks: Record<string, number>, rootDecls: RootRule[]): boolean {
    if (this.toggle) return true;
    if (!document.body) return false;
    const best = Object.entries(hooks)
      .filter(([k, n]) => n >= TOGGLE_MIN_RULES && !this.toggleRejected.has(k))
      .sort((a, b) => b[1] - a[1])[0];
    if (!best) return false;
    const key = best[0];
    const [kind, spec, target] = key.split('|');
    const el = target === 'body' ? document.body : document.documentElement;
    const added = !hasHook(el, kind, spec);
    const prev = kind === 'attr' ? el.getAttribute(spec.split('=')[0]) : null;
    if (added) setHook(el, kind, spec, true);
    const works = declaredDark(rootDecls);
    if (works === false) {
      if (added) setHook(el, kind, spec, false, prev);
      this.toggleRejected.add(key);
      return false;
    }
    this.nativeUnverified = works === null;
    const toggle: Toggle = {
      key,
      el,
      added,
      prev,
      restores: 0,
      at: performance.now(),
      observer: new MutationObserver(() => {
        if (hasHook(el, kind, spec)) return;
        if (toggle.restores < TOGGLE_RESTORES && performance.now() - toggle.at < TOGGLE_GUARD_MS) {
          toggle.restores++;
          setHook(el, kind, spec, true);
        } else {
          // The site (or its user) switched themes: their call.
          this.dropToggle(true);
          this.allDirty = true;
          this.schedule();
        }
      }),
    };
    toggle.observer.observe(el, { attributes: true, attributeFilter: [kind === 'class' ? 'class' : spec.split('=')[0]] });
    this.toggle = toggle;
    return true;
  }

  private dropToggle(reject: boolean) {
    const t = this.toggle;
    if (!t) return;
    this.toggle = null;
    t.observer.disconnect();
    const [kind, spec] = t.key.split('|');
    if (t.added) setHook(t.el, kind, spec, false, t.prev);
    if (reject) this.toggleRejected.add(t.key);
  }

  /**
   * Read from the site's CSS on every pass (cheap, so late theme changes are
   * caught). Only when that is inconclusive is the page measured with our
   * sheets off, once, since that forces a full style recalculation.
   */
  private isAlreadyDark(decls: RootRule[]): boolean {
    const declared = declaredDark(decls);
    if (declared !== null) return declared;
    if (this.measured) return false;
    this.measured = true;
    return this.measureDark(false);
  }

  // --- roots, inline styles, shadow DOM -----------------------------------

  private addRoot(root: Root): RootState {
    const inline = new CSSStyleSheet();
    const st: RootState = {
      root,
      pieces: new Map(),
      order: [],
      want: [inline],
      inline,
      inlineRules: new Map(),
      inlineDirty: false,
      inlineText: '',
      observer: new MutationObserver((records) => this.onMutations(st, records)),
      dirty: true,
      srcs: [],
      adopted: null,
    };
    this.ours.add(inline);
    this.roots.set(root, st);
    // The parser fires thousands of records before DOMContentLoaded; poll for sheets instead.
    if (root !== document || this.domReady) this.observe(st);
    else requestAnimationFrame(this.pollSheets);
    if (root !== document) {
      this.watchStyles(st, root);
      this.scanInline(st, root);
      this.walkShadows(root);
    }
    this.adopt(st);
    this.schedule();
    return st;
  }

  private observe(st: RootState) {
    st.observer.observe(st.root, { childList: true, subtree: true, attributes: true, attributeFilter: ATTRS });
  }

  private pollSheets = () => {
    if (!this.running || this.domReady) return;
    const n = document.styleSheets.length + document.adoptedStyleSheets.length;
    if (n !== this.sheetCount) {
      this.sheetCount = n;
      this.roots.get(document)!.dirty = true;
      this.update();
    }
    requestAnimationFrame(this.pollSheets);
  };

  /** `force`: the page reassigned the list, so ours may be gone even if our side didn't change. */
  private adopt(st: RootState, force = false) {
    const want = st.root === document && this.fallbackOn ? [this.fallback, ...st.want] : st.want;
    const prev = st.adopted;
    if (!force && prev && prev.length === want.length && want.every((s, i) => prev[i] === s)) return;
    st.adopted = want;
    const list = st.root.adoptedStyleSheets;
    const tail = list.length - want.length;
    if (tail >= 0 && want.every((s, i) => list[tail + i] === s) && !list.slice(0, tail).some((s) => this.ours.has(s))) return;
    st.root.adoptedStyleSheets = [...list.filter((s) => !this.ours.has(s)), ...want];
  }

  private watchStyles(st: RootState, node: ParentNode) {
    for (const el of node.querySelectorAll('style')) st.observer.observe(el, STYLE_TEXT);
  }

  private onMutations(st: RootState, records: MutationRecord[]) {
    this.timed(() => this.handleMutations(st, records));
  }

  private handleMutations(st: RootState, records: MutationRecord[]) {
    if (!this.running) return;
    let dirty = false;
    let added = false;
    for (const r of records) {
      const target = r.target as Element;
      if (r.type === 'characterData') {
        dirty = true;
      } else if (r.type === 'attributes') {
        const tag = target.localName;
        if (tag === 'link' || tag === 'style') dirty = true;
        else this.inlineAttr(st, target, r.attributeName!);
      } else {
        if (target.localName === 'style') dirty = true;
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          added = true;
          const el = n as Element;
          // While parsing, nodes arrive one by one and DOMContentLoaded scans everything once.
          if (this.domReady) dirty = this.scanAdded(st, el) || dirty;
          else if (this.track(st, el)) dirty = true;
        }
        for (const n of r.removedNodes) {
          if (n.nodeName === 'STYLE' || n.nodeName === 'LINK') dirty = true;
        }
      }
    }
    if (dirty) st.dirty = true;
    if (added && this.domReady) this.queueContrast();
    if (dirty || st.inlineDirty) this.schedule();
  }

  /** One query per inserted subtree covers styles, inline colors and shadow hosts. Returns whether sheets changed. */
  private scanAdded(st: RootState, el: Element): boolean {
    const sel = this.shadowTags.size ? `${SCAN},${[...this.shadowTags].join(',')}` : SCAN;
    let dirty = this.track(st, el);
    for (const e of el.querySelectorAll(sel)) dirty = this.track(st, e) || dirty;
    return dirty;
  }

  private track(st: RootState, el: Element): boolean {
    const tag = el.localName;
    if (el.shadowRoot && !this.roots.has(el.shadowRoot)) this.addRoot(el.shadowRoot);
    if (el.attributes.length) this.inlineEl(st, el);
    if (tag === 'style') {
      st.observer.observe(el, STYLE_TEXT);
      return true;
    }
    return tag === 'link';
  }

  private scanInline(st: RootState, node: ParentNode) {
    if (node instanceof Element && node.matches(INLINE)) this.inlineEl(st, node);
    for (const el of node.querySelectorAll(INLINE)) this.inlineEl(st, el);
  }

  private inlineEl(st: RootState, el: Element) {
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i++) this.inlineAttr(st, el, attrs[i].name, attrs[i].value);
  }

  private inlineAttr(st: RootState, el: Element, name: string, value = el.getAttribute(name)) {
    if (!value) return;
    let kind: string;
    if (name === 'style') kind = 's';
    else if (name === 'bgcolor') kind = 'b';
    else if (name === 'fill' && el instanceof SVGElement) kind = 'f';
    else if (name === 'stroke' && el instanceof SVGElement) kind = 'k';
    else if (name === 'color' && el.localName === 'font') kind = 'c';
    else if (name === 'text' && el.localName === 'body') kind = 't';
    else return;
    const key = kind + value;
    if (st.inlineRules.has(key)) return;
    const css = this.inlineCss(key);
    st.inlineRules.set(key, css);
    if (css) st.inlineDirty = true;
  }

  /**
   * Rules keyed on the attribute's exact value, so no element is ever
   * touched: `[style="background: #fff"]{background:#1a1a1a!important}`.
   * Presentation attributes rank below any author rule, hence :where().
   */
  private inlineCss(key: string): string {
    const kind = key[0];
    const value = key.slice(1);
    const q = cssString(value);
    if (kind === 's') {
      this.scratch.cssText = value;
      this.noteInlineVars(this.scratch);
      const decls = declarations(this.scratch, this.ctx, true);
      const ignore = this.fix?.ignoreInline.length ? `:not(:is(${this.fix.ignoreInline.join(',')}))` : '';
      return decls ? `[style=${q}]${ignore}{${decls}}` : '';
    }
    const [sel, prop, role] =
      kind === 'b'
        ? [`[bgcolor=${q}]`, 'background-color', 'bg' as const]
        : kind === 'f'
          ? [`[fill=${q}]`, 'fill', 'fg' as const]
          : kind === 'k'
            ? [`[stroke=${q}]`, 'stroke', 'fg' as const]
            : kind === 'c'
              ? [`font[color=${q}]`, 'color', 'fg' as const]
              : [`body[text=${q}]`, 'color', 'fg' as const];
    const v = this.ctx.transform(value, role);
    return v ? `:where(${sel}){${prop}:${v}}` : '';
  }

  private noteInlineVars(style: CSSStyleDeclaration) {
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (!prop.startsWith('--')) continue;
      const value = style.getPropertyValue(prop);
      const key = prop + ':' + value;
      if (this.inlineVarSeen.has(key) || this.inlineVarSeen.size > MAX_INLINE_RULES) continue;
      this.inlineVarSeen.add(key);
      this.inlineVarDecls.push([prop, value]);
      // Only a variable that isn't known as a color yet can change anything.
      if (!this.colorVars.has(prop)) this.inlineVarsChanged = true;
    }
  }

  private walkShadows(root: Root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const sr = (n as Element).shadowRoot;
      if (sr && !this.roots.has(sr)) this.addRoot(sr);
    }
  }

  /** Hosts of tags the page-world script saw calling attachShadow. */
  private findShadows(node: ParentNode) {
    if (!this.shadowTags.size) return;
    const sel = [...this.shadowTags].join(',');
    const hosts = [...node.querySelectorAll(sel)];
    if (node instanceof Element && node.matches(sel)) hosts.push(node);
    for (const el of hosts) {
      if (el.shadowRoot && !this.roots.has(el.shadowRoot)) this.addRoot(el.shadowRoot);
    }
  }
}

function hasHook(el: Element, kind: string, spec: string): boolean {
  if (kind === 'class') return el.classList.contains(spec);
  const [name, value] = spec.split('=');
  return el.getAttribute(name)?.toLowerCase() === value;
}

function setHook(el: Element, kind: string, spec: string, on: boolean, prev: string | null = null) {
  if (kind === 'class') {
    el.classList.toggle(spec, on);
    return;
  }
  const [name, value] = spec.split('=');
  if (on) el.setAttribute(name, value);
  else if (prev !== null) el.setAttribute(name, prev);
  else el.removeAttribute(name);
}
