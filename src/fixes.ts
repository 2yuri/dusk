/** Per-site fixes from Dark Reader's community configs, already narrowed to one page. */
export interface SiteFix {
  /** Elements to invert (logos, icons drawn as dark-on-transparent images). */
  invert: string[];
  /** Extra CSS. May use `${color}` templates and Dark Reader's variable names. */
  css: string;
  /** Elements whose inline style must stay as the site wrote it. */
  ignoreInline: string[];
  /** Listed as a site that is dark already. */
  dark: boolean;
  filter: { invert: string[]; noInvert: string[]; removeBg: string[]; css: string };
}

type DynEntry = [urls: string[], invert: string[], css: string, ignoreInline: string[]];
type InvEntry = [urls: string[], invert: string[], noInvert: string[], removeBg: string[], css: string];
interface Raw {
  dyn: DynEntry[];
  inv: InvEntry[];
  dark: string[];
}

/**
 * Dark Reader URL patterns: `example.com` (also www.), `*.example.com`
 * (subdomains), `google.*` (any TLD), optional path prefix, `*` for the
 * global entry.
 */
export function compilePattern(p: string): RegExp {
  if (p === '*') return /^/;
  const slash = p.indexOf('/');
  const host = slash < 0 ? p : p.slice(0, slash);
  const path = slash < 0 ? '' : p.slice(slash);
  const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const hostRe = esc(host).replace(/\*/g, '[^/]*');
  const pathRe = path ? esc(path).replace(/\*/g, '.*') : '(?:[/?#]|$)';
  return new RegExp(`^(?:www\\.)?${hostRe}${pathRe}`, 'i');
}

export class FixIndex {
  private dyn: [RegExp[], DynEntry][];
  private inv: [RegExp[], InvEntry][];
  private dark: RegExp[];

  constructor(raw: Raw) {
    this.dyn = raw.dyn.map((e) => [e[0].map(compilePattern), e]);
    this.inv = raw.inv.map((e) => [e[0].map(compilePattern), e]);
    this.dark = raw.dark.map(compilePattern);
  }

  lookup(url: string): SiteFix {
    const u = new URL(url);
    const target = u.hostname + u.pathname;
    const hit = (res: RegExp[]) => res.some((r) => r.test(target));
    const fix: SiteFix = {
      invert: [],
      css: '',
      ignoreInline: [],
      dark: hit(this.dark),
      filter: { invert: [], noInvert: [], removeBg: [], css: '' },
    };
    for (const [res, [, invert, css, ignoreInline]] of this.dyn) {
      if (!hit(res)) continue;
      fix.invert.push(...invert);
      if (css) fix.css += css + '\n';
      fix.ignoreInline.push(...ignoreInline);
    }
    for (const [res, [, invert, noInvert, removeBg, css]] of this.inv) {
      if (!hit(res)) continue;
      fix.filter.invert.push(...invert);
      fix.filter.noInvert.push(...noInvert);
      fix.filter.removeBg.push(...removeBg);
      if (css) fix.filter.css += css + '\n';
    }
    return fix;
  }
}
