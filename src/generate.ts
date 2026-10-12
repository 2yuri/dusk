import { DEP_IMAGES, DEP_VARS, declarations, type Ctx } from './transform.ts';

const DARK_QUERY = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i;

/** What a pass needs to know about a sheet before generating anything. Cheap: most rules are only looked at, not read. */
export interface SheetInfo {
  /** Style rules guarded by `prefers-color-scheme: dark`. */
  darkRules: number;
  /** Whether one of those applies to html/body, i.e. it is a real theme, not a widget. */
  darkRoot: boolean;
  /** Declarations on html/body, enough to tell whether the site is dark without rendering it. */
  root: RootRule[];
  /**
   * Weight per dark-theme hook (`.dark`, `[data-theme=dark]`...), for themes
   * behind a site's own toggle: one per rule, plus one per ten custom
   * properties, since some sites switch their whole theme in a few
   * variable-heavy rules (Bootstrap, Supabase).
   */
  hooks: Record<string, number>;
}

/**
 * How sites switch to a dark theme they ship behind a toggle. A hook is
 * `class|name|target` or `attr|name=value|target`, target being the element
 * the selectors expect it on.
 */
const CLASS_HOOK = /(html|body|:root)?\.((?:theme-)?dark(?:-(?:mode|theme))?|theme--dark|night-mode)(?![\w\\-])/gi;
const ATTR_HOOK = /(html|body|:root)?\[(data-[\w-]*(?:theme|mode|scheme)[\w-]*)\s*=\s*["']?(dark|night)["']?\s*\]/gi;

export function hookKeys(selectorText: string): string[] {
  if (!/dark|night/i.test(selectorText)) return [];
  const keys = new Set<string>();
  for (const m of selectorText.matchAll(CLASS_HOOK)) keys.add(`class|${m[2].toLowerCase()}|${m[1]?.toLowerCase() === 'body' ? 'body' : 'html'}`);
  for (const m of selectorText.matchAll(ATTR_HOOK)) keys.add(`attr|${m[2].toLowerCase()}=${m[3].toLowerCase()}|${m[1]?.toLowerCase() === 'body' ? 'body' : 'html'}`);
  return [...keys];
}

/** A rule that may style html/body, with the declarations that decide whether the page is dark. */
export interface RootRule {
  sel: string;
  media: string[];
  /** Custom properties, plus `bg` / `color` / `scheme`. One entry per rule keeps matching to once per selector. */
  props: [prop: string, value: string][];
}

/** Whether some selector in the list has html, body or :root as its subject. */
function targetsRoot(selectorText: string): boolean {
  if (!selectorText.includes('html') && !selectorText.includes('body') && !selectorText.includes(':root')) return false;
  return selectorText.split(',').some((sel) => /^(html|body|:root)(?![\w-])/i.test(sel.trim().split(/[\s>+~]+/).pop() ?? ''));
}

/**
 * Whether a rule styles html or body. Themes often hang off the root by
 * attribute or class alone (`[data-color-mode=dark]`, `.dark`), so
 * combinator-free selectors are checked against the live elements.
 */
function appliesToRoot(selectorText: string): boolean {
  if (targetsRoot(selectorText)) return true;
  if (/[\s>+~]/.test(selectorText.replace(/\s*,\s*/g, ','))) return false;
  // Most rules are component classes; rule them out by the root's own classes and attributes before matching.
  if (!selectorText.split(',').some(mayMatchRoot)) return false;
  try {
    return !!(document.documentElement?.matches(selectorText) || document.body?.matches(selectorText));
  } catch {
    return false;
  }
}

/** Whether every class and attribute in a compound is present on html or body. */
function mayMatchRoot(compound: string): boolean {
  const html = document.documentElement;
  const body = document.body;
  for (const m of compound.matchAll(/\.([\w-]+)/g)) {
    if (!html?.classList.contains(m[1]) && !body?.classList.contains(m[1])) return false;
  }
  for (const m of compound.matchAll(/\[([\w-]+)/g)) {
    if (!html?.hasAttribute(m[1]) && !body?.hasAttribute(m[1])) return false;
  }
  return true;
}

/**
 * Whether a hook-guarded selector could style html or body once the hook is
 * set: its subject, minus the hook and any :where()/:is() groups, is empty,
 * a root tag, or plain classes and attributes (Tailwind's
 * `.dark\:bg-black:where(.dark, .dark *)` on <body>).
 */
function hookMayStyleRoot(selectorText: string): boolean {
  return selectorText.split(/,(?![^(]*\))/).some((part) => {
    const stripped = part.replace(/:(where|is|not)\((?:[^()]|\([^()]*\))*\)/g, '');
    const subject = (stripped.trim().split(/[\s>+~]+/).pop() ?? '').replace(CLASS_HOOK, '$1').replace(ATTR_HOOK, '$1');
    return subject === '' || /^(html|body|:root)$/i.test(subject) || /^(html|body)?([.[#][^\s]*)$/i.test(subject);
  });
}

export type RulesOf = (sheet: CSSStyleSheet) => CSSRuleList | null;

function isDarkMedia(media: string): boolean {
  return DARK_QUERY.test(media) && !/\bnot\b/i.test(media);
}

export function scan(rules: CSSRuleList, rulesOf: RulesOf, info: SheetInfo, inDark: boolean, media: string[] = []) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      const sel = rule.selectorText;
      const hooks = hookKeys(sel);
      if (hooks.length) {
        let vars = 0;
        for (let j = 0; j < rule.style.length; j++) if (rule.style[j].startsWith('--')) vars++;
        for (const k of hooks) info.hooks[k] = (info.hooks[k] ?? 0) + 1 + vars / 10;
      }
      // Hook-guarded rules only match once the hook is set; keep the ones that could land on html/body for that check.
      const root = appliesToRoot(sel) || (hooks.length > 0 && hookMayStyleRoot(sel));
      if (root) {
        const style = rule.style;
        const props: [string, string][] = [];
        for (let j = 0; j < style.length; j++) {
          const prop = style[j];
          if (prop.startsWith('--')) props.push([prop, style.getPropertyValue(prop)]);
        }
        const bg = style.getPropertyValue('background-color') || style.getPropertyValue('background');
        if (bg) props.push(['bg', bg]);
        const color = style.getPropertyValue('color');
        if (color) props.push(['color', color]);
        // light-dark() picks by color-scheme, so the scheme decides what a site's colors resolve to.
        const scheme = style.getPropertyValue('color-scheme');
        if (scheme) props.push(['scheme', scheme]);
        if (props.length) info.root.push({ sel, media, props });
      }
      if (inDark) {
        info.darkRules++;
        if (root) info.darkRoot = true;
      }
      if (rule.cssRules.length) scan(rule.cssRules, rulesOf, info, inDark, media);
    } else if (rule instanceof CSSMediaRule) {
      const m = rule.media.mediaText;
      scan(rule.cssRules, rulesOf, info, inDark || isDarkMedia(m), [...media, m]);
    } else if (rule instanceof CSSImportRule) {
      const sub = rule.styleSheet && rulesOf(rule.styleSheet);
      const m = rule.media.mediaText;
      if (sub) scan(sub, rulesOf, info, inDark || isDarkMedia(m), m ? [...media, m] : media);
    } else if (rule instanceof CSSGroupingRule) {
      scan(rule.cssRules, rulesOf, info, inDark, media);
    }
  }
}

/** Every custom property declaration. Only needed when colors are rewritten, so kept out of `scan`. */
export function scanVars(rules: CSSRuleList, rulesOf: RulesOf, out: [name: string, value: string][]) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule instanceof CSSStyleRule) {
      const style = rule.style;
      for (let j = 0; j < style.length; j++) {
        const prop = style[j];
        if (prop.startsWith('--')) out.push([prop, style.getPropertyValue(prop)]);
      }
      if (rule.cssRules.length) scanVars(rule.cssRules, rulesOf, out);
    } else if (rule instanceof CSSImportRule) {
      const sub = rule.styleSheet && rulesOf(rule.styleSheet);
      if (sub) scanVars(sub, rulesOf, out);
    } else if (rule instanceof CSSGroupingRule) {
      scanVars(rule.cssRules, rulesOf, out);
    }
  }
}

export function newInfo(): SheetInfo {
  return { darkRules: 0, darkRoot: false, root: [], hooks: {} };
}

/** The prelude of a grouping rule we have no dedicated accessor for (@scope, ...). */
function prelude(rule: CSSRule): string {
  const text = rule.cssText;
  return text.slice(0, text.indexOf('{')).trim();
}

function groupPrelude(rule: CSSGroupingRule): string | null {
  if (rule instanceof CSSMediaRule) return `@media ${rule.media.mediaText}`;
  if (rule instanceof CSSSupportsRule) return `@supports ${rule.conditionText}`;
  if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) return rule.name ? `@layer ${rule.name}` : null;
  if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) return `@container ${rule.conditionText}`;
  return prelude(rule);
}

/**
 * Override rules for a list of rules, mirroring selectors and at-rule
 * wrappers so the cascade between the overrides matches the original.
 */
interface Memo {
  text: string;
  deps: number;
  varGen: number;
  imgGen: number;
}

export class Generator {
  private memo = new WeakMap<CSSRule, Memo>();
  private varGen = 0;
  private imgGen = 0;

  /** Drop memoized output that depended on these inputs. */
  invalidate(deps: number) {
    if (deps & DEP_VARS) this.varGen++;
    if (deps & DEP_IMAGES) this.imgGen++;
  }

  /** A stamp for memos kept outside the generator (per sheet). */
  stamp(deps: number): number {
    return (deps & DEP_VARS ? this.varGen : 0) * 65536 + (deps & DEP_IMAGES ? this.imgGen : 0);
  }

  /** Runs `fn`, returning its result and the dependencies it picked up. */
  tracked(fn: () => string): [text: string, deps: number] {
    const outer = this.ctx.deps;
    this.ctx.deps = 0;
    const text = fn();
    const deps = this.ctx.deps;
    this.ctx.deps = outer | deps;
    return [text, deps];
  }

  private cached(rule: CSSRule, make: () => string): string {
    const m = this.memo.get(rule);
    if (m && (!(m.deps & DEP_VARS) || m.varGen === this.varGen) && (!(m.deps & DEP_IMAGES) || m.imgGen === this.imgGen)) {
      this.ctx.deps |= m.deps;
      return m.text;
    }
    const [text, deps] = this.tracked(make);
    this.memo.set(rule, { text, deps, varGen: this.varGen, imgGen: this.imgGen });
    return text;
  }

  readonly ctx: Ctx;
  readonly rulesOf: RulesOf;

  constructor(ctx: Ctx, rulesOf: RulesOf) {
    this.ctx = ctx;
    this.rulesOf = rulesOf;
  }

  list(rules: CSSRuleList): string {
    let out = '';
    for (let i = 0; i < rules.length; i++) out += this.rule(rules[i]);
    return out;
  }

  private rule(rule: CSSRule): string {
    if (rule instanceof CSSStyleRule) {
      return this.cached(rule, () => {
        const decls = declarations(rule.style, this.ctx, false);
        const nested = rule.cssRules.length ? this.list(rule.cssRules) : '';
        return decls || nested ? `${rule.selectorText}{${decls}${nested}}` : '';
      });
    }
    if (rule instanceof CSSGroupingRule) {
      const inner = this.list(rule.cssRules);
      if (!inner) return '';
      const head = groupPrelude(rule);
      return head === null ? inner : `${head}{${inner}}`;
    }
    if (rule instanceof CSSImportRule) {
      const sub = rule.styleSheet && this.rulesOf(rule.styleSheet);
      if (!sub) return '';
      const base = this.ctx.base;
      this.ctx.base = rule.styleSheet!.href ?? base;
      let inner = this.list(sub);
      this.ctx.base = base;
      if (!inner) return '';
      if (rule.layerName != null) inner = rule.layerName ? `@layer ${rule.layerName}{${inner}}` : inner;
      const media = rule.media.mediaText;
      return media && media !== 'all' ? `@media ${media}{${inner}}` : inner;
    }
    if (rule instanceof CSSKeyframesRule) return this.cached(rule, () => this.keyframes(rule));
    if (typeof CSSNestedDeclarations !== 'undefined' && rule instanceof CSSNestedDeclarations) {
      // Bare declarations between nested rules: `.a { color: red; .b {} color: blue }`.
      return declarations(rule.style, this.ctx, false);
    }
    return '';
  }

  /** A later @keyframes with the same name replaces the original wholesale, so copy every declaration. */
  private keyframes(rule: CSSKeyframesRule): string {
    let changed = false;
    let body = '';
    for (let i = 0; i < rule.cssRules.length; i++) {
      const kf = rule.cssRules[i] as CSSKeyframeRule;
      const colors = declarations(kf.style, this.ctx, false);
      if (colors) changed = true;
      body += `${kf.keyText}{${kf.style.cssText}${colors}}`;
    }
    return changed ? `@keyframes ${CSS.escape(rule.name)}{${body}}` : '';
  }

  /**
   * The site's own dark theme, unconditionally: every rule under
   * `prefers-color-scheme: dark` is copied with that query neutralized.
   */
  native(rules: CSSRuleList, inDark: boolean): string {
    let out = '';
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule instanceof CSSMediaRule) {
        const media = rule.media.mediaText;
        if (isDarkMedia(media)) {
          const rest = forceDark(media);
          let inner = '';
          for (let j = 0; j < rule.cssRules.length; j++) inner += rule.cssRules[j].cssText;
          out += `@media ${rest}{${inner}}`;
        } else {
          const inner = this.native(rule.cssRules, inDark);
          if (inner) out += `@media ${media}{${inner}}`;
        }
      } else if (inDark) {
        out += rule.cssText;
      } else if (rule instanceof CSSGroupingRule) {
        const inner = this.native(rule.cssRules, false);
        const head = groupPrelude(rule);
        if (inner) out += head === null ? inner : `${head}{${inner}}`;
      } else if (rule instanceof CSSImportRule) {
        const sub = rule.styleSheet && this.rulesOf(rule.styleSheet);
        if (sub) out += this.native(sub, isDarkMedia(rule.media.mediaText));
      }
    }
    return out;
  }
}

/** A dark-scheme media query with the scheme condition made always true. */
export function forceDark(media: string): string {
  return isDarkMedia(media) ? media.replace(DARK_QUERY, '(min-width: 0px)') : media;
}

export { isDarkMedia };
