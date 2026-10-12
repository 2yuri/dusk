import { isNamedColor, modify, parseFunc, parseHex, parseNamed, parseViaCanvas, serialize, type RGBA, type Role, type Theme } from './color.ts';

export type { Role, Theme };
export const ROLES: Role[] = ['bg', 'fg', 'bd'];

/**
 * One alternation, scanned left to right. Strings, urls and custom property
 * names are matched first so a color word inside them is never touched.
 */
const TOKEN =
  /url\(\s*(['"]?)(.*?)\1\s*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|var\(\s*(--[\w-]+)|--[\w-]+|(#[\da-f]{3,8})(?![\w-])|\b(rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(((?:[^()]|\([^()]*\))*)\)|(?<![\w-])([a-z]+)(?![\w(-])/gi;

const ROLE = new Map<string, Role>([
  ['background-color', 'bg'],
  ['background-image', 'bg'],
  ['background', 'bg'],
  ['box-shadow', 'bg'],
  ['text-shadow', 'bg'],
  ['stop-color', 'bg'],
  ['flood-color', 'bg'],
  ['lighting-color', 'bg'],
  ['scrollbar-color', 'bg'],
  ['color', 'fg'],
  ['fill', 'fg'],
  ['stroke', 'fg'],
  ['caret-color', 'fg'],
  ['text-decoration-color', 'fg'],
  ['text-decoration', 'fg'],
  ['text-emphasis-color', 'fg'],
  ['-webkit-text-fill-color', 'fg'],
  ['-webkit-text-stroke-color', 'fg'],
  ['outline-color', 'bd'],
  ['outline', 'bd'],
  ['column-rule-color', 'bd'],
  ['column-rule', 'bd'],
]);

const BORDER_SHORTHAND = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?$/;

export function roleOf(prop: string): Role | null {
  const r = ROLE.get(prop);
  if (r) return r;
  if (prop.startsWith('border') && (prop.endsWith('-color') || BORDER_SHORTHAND.test(prop))) return 'bd';
  return null;
}

/** The shorthand that carried a var() for a longhand the browser left empty. */
export function shorthandsOf(prop: string): string[] {
  if (prop.startsWith('background-')) return ['background'];
  if (prop.startsWith('outline-')) return ['outline'];
  if (prop.startsWith('column-rule-')) return ['column-rule'];
  if (prop.startsWith('text-decoration-')) return ['text-decoration'];
  if (prop.startsWith('border-')) {
    const parts = prop.split('-');
    const out: string[] = [];
    for (let k = parts.length - 1; k >= 2; k--) out.push(parts.slice(0, k).join('-'));
    out.push('border-color', 'border');
    return out;
  }
  return [];
}

/**
 * What a generated value depended on besides its own text. Memoized output
 * carrying a bit is redone when that input changes, and only then.
 */
export const DEP_VARS = 1;
export const DEP_IMAGES = 2;

export class Ctx {
  /** Per-sheet base URL used to absolutize url() in emitted values. */
  base: string | null = null;
  /**
   * Replacement for a background image (dark icons get recolored), null to
   * keep it. Asking for an unknown URL starts its analysis.
   */
  imageFor?: (url: string) => string | null;
  /** Dependencies of everything transformed since the caller last reset it. */
  deps = 0;
  private cache = new Map<string, [out: string | null, deps: number]>();
  private colorish = new Map<string, boolean>();
  private colors = new Map<string, RGBA | null>();

  readonly theme: Theme;
  colorVars: Set<string>;

  constructor(theme: Theme, colorVars: Set<string>) {
    this.theme = theme;
    this.colorVars = colorVars;
  }

  setColorVars(next: Set<string>) {
    this.colorVars = next;
    this.invalidate(DEP_VARS);
    for (const k of this.colorish.keys()) if (k.includes('var(')) this.colorish.delete(k);
  }

  invalidate(deps: number) {
    for (const [k, [, d]] of this.cache) if (d & deps) this.cache.delete(k);
  }

  varName(name: string, role: Role): string {
    return `--dusk-${role}${name}`;
  }

  /** The value with its colors moved into the dark palette, or null if nothing changed. */
  transform(value: string, role: Role): string | null {
    if (value.includes('light-dark(')) return null;
    const key = role + (this.base ?? '') + value;
    const hit = this.cache.get(key);
    if (hit) {
      this.deps |= hit[1];
      return hit[0];
    }
    let changed = false;
    let deps = 0;
    const res = value.replace(TOKEN, (m, _q, url, varRef, hex, fn, args, word) => {
      if (url !== undefined) {
        if (role === 'bg' && this.imageFor) {
          deps |= DEP_IMAGES;
          const abs = this.resolve(url);
          const replacement = abs && this.imageFor(abs);
          if (replacement) {
            changed = true;
            return `url("${replacement}")`;
          }
        }
        return this.absolutize(m, url);
      }
      if (varRef !== undefined) {
        deps |= DEP_VARS;
        if (!this.colorVars.has(varRef)) return m;
        changed = true;
        return m.replace(varRef, this.varName(varRef, role));
      }
      if (hex !== undefined) {
        const c = this.color(hex, () => parseHex(hex));
        if (!c) return m;
        changed = true;
        return serialize(modify(c, role, this.theme));
      }
      if (fn !== undefined) {
        const lower = fn.toLowerCase();
        if (lower.startsWith('rgb') || lower.startsWith('hsl')) {
          const p = parseFunc(lower, args);
          if (!p) return m;
          changed = true;
          return serialize(modify(p.color, role, this.theme), p.alphaExpr);
        }
        if (args.includes('var(')) return m;
        const c = this.color(m, () => parseViaCanvas(m));
        if (!c) return m;
        changed = true;
        return serialize(modify(c, role, this.theme));
      }
      if (word !== undefined && isNamedColor(word)) {
        changed = true;
        return serialize(modify(parseNamed(word)!, role, this.theme));
      }
      return m;
    });
    const out = changed ? res : null;
    this.cache.set(key, [out, deps]);
    this.deps |= deps;
    return out;
  }

  /** Whether a custom property value holds a color (or a var() of one). */
  isColorish(value: string): boolean {
    let v = this.colorish.get(value);
    if (v !== undefined) return v;
    v = false;
    TOKEN.lastIndex = 0;
    for (const m of value.matchAll(TOKEN)) {
      const [, , , varRef, hex, fn, , word] = m;
      if (
        (varRef !== undefined && this.colorVars.has(varRef)) ||
        hex !== undefined ||
        fn !== undefined ||
        (word !== undefined && (isNamedColor(word) || /^(transparent|currentcolor)$/i.test(word)))
      ) {
        v = true;
        break;
      }
    }
    this.colorish.set(value, v);
    return v;
  }

  private color(key: string, parse: () => RGBA | null): RGBA | null {
    let c = this.colors.get(key);
    if (c === undefined) this.colors.set(key, (c = parse()));
    return c;
  }

  private resolve(url: string): string | null {
    if (/^data:/i.test(url)) return url;
    try {
      return new URL(url, this.base ?? globalThis.document?.baseURI).href;
    } catch {
      return null;
    }
  }

  private absolutize(m: string, url: string): string {
    if (!this.base || /^([a-z][\w+.-]*:|#|\/\/)/i.test(url)) return m;
    try {
      return `url("${new URL(url, this.base).href}")`;
    } catch {
      return m;
    }
  }
}

/** Names of custom properties referenced through var() in a value. */
export function varRefs(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) out.push(m[1]);
  return out;
}

/**
 * Color declarations of one CSSStyleDeclaration, rewritten for the dark
 * palette. Custom properties holding colors get one variant per role so
 * usages can pick the right one: `background: var(--x)` becomes
 * `background: var(--dusk-bg--x)`.
 */
export function declarations(style: CSSStyleDeclaration, ctx: Ctx, forceImportant: boolean): string {
  let out = '';
  let shorthandsDone: Set<string> | undefined;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const imp = forceImportant || style.getPropertyPriority(prop) === 'important' ? '!important' : '';
    if (prop.startsWith('--')) {
      // Whether this property counts as a color can change as more sheets load.
      ctx.deps |= DEP_VARS;
      if (!ctx.colorVars.has(prop)) continue;
      const value = style.getPropertyValue(prop);
      for (const role of ROLES) out += `${ctx.varName(prop, role)}:${ctx.transform(value, role) ?? value}${imp};`;
      continue;
    }
    const role = roleOf(prop);
    if (!role) continue;
    const value = style.getPropertyValue(prop);
    if (value === '') {
      for (const sh of shorthandsOf(prop)) {
        const shValue = style.getPropertyValue(sh);
        if (!shValue) continue;
        shorthandsDone ??= new Set();
        if (!shorthandsDone.has(sh)) {
          shorthandsDone.add(sh);
          const v = ctx.transform(shValue, roleOf(sh) ?? role);
          if (v !== null) out += `${sh}:${v}${imp};`;
        }
        break;
      }
      continue;
    }
    const v = ctx.transform(value, role);
    if (v !== null) out += `${prop}:${v}${imp};`;
  }
  return out;
}
