import { firstColor, luminance, parseColor, type RGBA } from './color.ts';
import { forceDark, type RootRule } from './generate.ts';

/** Whether the page as currently rendered reads as a dark design. */
export function renderedDark(): boolean {
  const root = document.documentElement;
  if (!root) return false;
  const html = getComputedStyle(root);
  const body = document.body && getComputedStyle(document.body);
  const bodyBg = body && parseColor(body.backgroundColor);
  const htmlBg = parseColor(html.backgroundColor);
  const bg = bodyBg && bodyBg.a >= 0.5 ? bodyBg : htmlBg && htmlBg.a >= 0.5 ? htmlBg : null;
  if (bg) return luminance(bg) < 0.2;
  const scheme = html.colorScheme;
  if (/\bdark\b/.test(scheme) && !/\blight\b/.test(scheme)) return true;
  // Transparent canvas with light text: the dark background lives on a wrapper.
  const text = parseColor((body ?? html).color);
  return text ? luminance(text) > 0.5 : false;
}

/** Measure with the given sheets switched off, i.e. the page as the site styled it. */
export function darkWithout(sheets: CSSStyleSheet[]): boolean {
  for (const s of sheets) s.disabled = true;
  try {
    return renderedDark();
  } finally {
    for (const s of sheets) s.disabled = false;
  }
}

/** Sites opt out of dark-mode extensions with this meta tag. */
export function isLocked(): boolean {
  return document.querySelector('meta[name="darkreader-lock"]') !== null;
}

const mediaCache = new Map<string, boolean>();
const mediaMatches = (m: string) => {
  let v = mediaCache.get(m);
  if (v === undefined) mediaCache.set(m, (v = matchMedia(m).matches));
  return v;
};

function matches(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

/** Top-level parts of a selector list. */
function parts(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out.map((p) => p.trim());
}

/** Selector specificity as one sortable number (ids, then classes/attributes/pseudo-classes, then types). */
export function specificity(sel: string): number {
  const s = sel.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '.a').replace(/::?(is|not|has)\(/g, ' ');
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w\\-]+|:(?!:)[\w-]+/g) ?? []).length;
  const types = (s.match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
  return ids * 1e6 + classes * 1e3 + types;
}

const specCache = new Map<string, number>();
/** Specificity of the most specific part of `sel` that matches `el`, or -1. */
function matchSpecificity(el: Element, sel: string): number {
  if (!matches(el, sel)) return -1;
  let best = -1;
  for (const part of parts(sel)) {
    if (!matches(el, part)) continue;
    let sp = specCache.get(part);
    if (sp === undefined) specCache.set(part, (sp = specificity(part)));
    if (sp > best) best = sp;
  }
  return best;
}

/**
 * Whether the site is dark, read from its own html/body declarations instead
 * of from rendering, so it costs no style recalculation. Later matching
 * declarations win, which is how most sites write their themes. Returns
 * null when the answer depends on something we can't resolve here.
 * `assumeDarkScheme` evaluates it as if the OS asked for dark, i.e. whether
 * the site's own dark theme would apply.
 */
export function declaredDark(rules: RootRule[], assumeDarkScheme = false): boolean | null {
  const html = document.documentElement;
  const body = document.body;
  if (!html || !body) return null;
  const vars = new Map<string, string>();
  // The cascade, approximated: higher specificity wins, later wins a tie.
  const won = new Map<string, number>();
  const take = (key: string, spec: number) => {
    if ((won.get(key) ?? -1) > spec) return false;
    won.set(key, spec);
    return true;
  };
  let htmlBg: string | undefined;
  let bodyBg: string | undefined;
  let color: string | undefined;
  let scheme: string | undefined;
  for (const rule of rules) {
    if (!rule.media.every((m) => mediaMatches(assumeDarkScheme ? forceDark(m) : m))) continue;
    const onHtml = matchSpecificity(html, rule.sel);
    const onBody = matchSpecificity(body, rule.sel);
    if (onHtml < 0 && onBody < 0) continue;
    const either = Math.max(onHtml, onBody);
    for (const [prop, value] of rule.props) {
      if (prop === 'bg') {
        if (onHtml >= 0 && take('bg:html', onHtml)) htmlBg = value;
        if (onBody >= 0 && take('bg:body', onBody)) bodyBg = value;
      } else if (prop === 'color') {
        if (take('color', either)) color = value;
      } else if (prop === 'scheme') {
        if (onHtml >= 0 && take('scheme', onHtml)) scheme = value;
      } else if (take(prop, either)) {
        vars.set(prop, value);
      }
    }
  }
  for (const el of [html, body]) {
    const st = (el as HTMLElement).style;
    for (let i = 0; i < st.length; i++) if (st[i].startsWith('--')) vars.set(st[i], st.getPropertyValue(st[i]));
  }
  bodyBg = body.style.backgroundColor || body.getAttribute('bgcolor') || bodyBg;
  htmlBg = html.style.backgroundColor || htmlBg;

  const dark = !!scheme && /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme);
  let unresolved = false;
  const resolve = (value: string | undefined): RGBA | null => {
    if (!value) return null;
    for (let depth = 0; depth < 8 && (value.includes('var(') || value.includes('light-dark(')); depth++) {
      value = value.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g, (_, name: string, fb?: string) => vars.get(name) ?? fb ?? '');
      value = pickLightDark(value, dark);
    }
    if (value.includes('var(')) {
      unresolved = true;
      return null;
    }
    const c = firstColor(value);
    if (!c && /\S/.test(value) && !/^(none|initial|inherit|unset|revert)$/i.test(value.trim())) unresolved = true;
    return c;
  };
  const b = resolve(bodyBg);
  const h = resolve(htmlBg);
  const bg = b && b.a >= 0.5 ? b : h && h.a >= 0.5 ? h : null;
  if (bg) return luminance(bg) < 0.2;
  if (unresolved) return null;
  // No background anywhere: light text means a dark design painted by a wrapper.
  const text = resolve(color);
  return text ? luminance(text) > 0.5 : false;
}

/** `light-dark(a, b)` resolved for a page whose color-scheme is (or isn't) dark. */
function pickLightDark(value: string, dark: boolean): string {
  for (let i = value.indexOf('light-dark('); i >= 0; i = value.indexOf('light-dark(')) {
    const start = i + 'light-dark('.length;
    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let j = start; j < value.length; j++) {
      const ch = value[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) {
          end = j;
          break;
        }
        depth--;
      } else if (ch === ',' && depth === 0 && comma < 0) comma = j;
    }
    if (end < 0 || comma < 0) return value;
    const pick = dark ? value.slice(comma + 1, end) : value.slice(start, comma);
    value = value.slice(0, i) + pick.trim() + value.slice(end + 1);
  }
  return value;
}
