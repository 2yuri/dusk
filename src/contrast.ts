import { hslToRgb, luminance, parseColor, rgbToHsl, serialize, type RGBA } from './color.ts';

const ATTR = 'data-dusk-contrast';
const MAX_TEXT_NODES = 600;
const AA = 4.5;
const AA_LARGE = 3;

function ratio(a: RGBA, b: RGBA): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `top` painted over an opaque `bottom`. */
function over(top: RGBA, bottom: RGBA): RGBA {
  const a = top.a;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

/** The closest color to `fg` (same hue and saturation) that reaches `target` against `bg`. */
export function readable(fg: RGBA, bg: RGBA, target: number): RGBA {
  const [h, s, l0] = rgbToHsl(fg);
  const lighter = luminance(bg) < 0.5;
  let lo = l0;
  let hi = lighter ? 1 : 0;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (ratio(hslToRgb(h, s, mid), bg) >= target) hi = mid;
    else lo = mid;
  }
  return hslToRgb(h, s, hi);
}

/**
 * Checks visible text against what is really painted behind it and lightens
 * whatever falls below WCAG AA. Runs at idle time on the page as it stands,
 * so it catches cases rule-by-rule rewriting can't: text inheriting a color
 * from far up the tree, set over a background from somewhere else entirely.
 */
export class ContrastGuard {
  checked = 0;
  fixed = 0;
  /** Elements already judged; scrolling brings new ones into range without redoing these. */
  private done = new WeakSet<Element>();
  /** Corrected colors in use, for the rules that apply them. */
  private colors = new Set<string>();

  /** Rules for the corrections made so far. */
  get css(): string {
    let out = '';
    for (const c of this.colors) out += `[${ATTR}="${c}"]{color:${c}!important}`;
    return out;
  }

  run(): boolean {
    const body = document.body;
    if (!body) return false;
    const page = this.pageBackground();
    const bgCache = new Map<Element, RGBA | null>();
    const seen = new Set<Element>();
    const before = this.colors.size;
    // Only text on screen or a screen away: long pages would otherwise cost the most for what nobody is reading yet.
    const top = -innerHeight;
    const bottom = innerHeight * 2;
    let fixed = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let node = walker.nextNode(); node && n < MAX_TEXT_NODES; node = walker.nextNode()) {
      if (!node.nodeValue?.trim()) continue;
      n++;
      const el = node.parentElement;
      if (!el || seen.has(el) || this.done.has(el) || el instanceof SVGElement) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (!rect.width || rect.bottom < top || rect.top > bottom) continue;
      this.done.add(el);
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.opacity === '0') continue;
      const fg = parseColor(cs.color);
      const bg = this.background(el, page, bgCache);
      if (!fg || !bg || fg.a === 0) continue;
      this.checked++;
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const target = large ? AA_LARGE : AA;
      const seenFg = over(fg, bg);
      if (ratio(seenFg, bg) >= target) continue;
      const fix = serialize(readable(seenFg, bg, target + 0.1));
      this.colors.add(fix);
      el.setAttribute(ATTR, fix);
      fixed++;
    }
    this.fixed += fixed;
    return this.colors.size !== before;
  }

  /** Remove every correction, e.g. before checking again with a new palette. */
  clear() {
    for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
    this.colors.clear();
    this.done = new WeakSet();
    this.checked = 0;
    this.fixed = 0;
  }

  private pageBackground(): RGBA {
    for (const el of [document.body, document.documentElement]) {
      const c = parseColor(getComputedStyle(el).backgroundColor);
      if (c && c.a >= 0.95) return c;
    }
    // The canvas: dark, since Dusk set color-scheme: dark.
    return { r: 18, g: 18, b: 18, a: 1 };
  }

  /** What is painted behind `el`: the first opaque ancestor background, with translucent layers on top. Null over images. */
  private background(el: Element, page: RGBA, cache: Map<Element, RGBA | null>): RGBA | null {
    const layers: RGBA[] = [];
    const chain: Element[] = [];
    let cur: Element | null = el;
    let base: RGBA | null | undefined;
    while (cur && cur !== document.documentElement) {
      if (cache.has(cur)) {
        base = cache.get(cur)!;
        break;
      }
      chain.push(cur);
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage !== 'none') {
        base = null;
        break;
      }
      const c = parseColor(cs.backgroundColor);
      if (c && c.a >= 0.95) {
        base = c;
        break;
      }
      if (c && c.a > 0) layers.push(c);
      cur = cur.parentElement;
    }
    if (base === undefined) base = page;
    let result: RGBA | null = base;
    if (result) for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result);
    // With translucent layers in between, ancestors see a different color than `el`; only cache the plain case.
    if (!layers.length) for (const c of chain) cache.set(c, result);
    return result;
  }
}
