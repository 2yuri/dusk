import type { Theme } from './color.ts';
import { darkWithout, renderedDark } from './detect.ts';
import type { SiteFix } from './fixes.ts';

const MEDIA = 'img,video,canvas,iframe,embed,object,svg image,[style*="background-image"]';

function fixCss(fix: SiteFix | null): string {
  if (!fix) return '';
  const { invert, noInvert, removeBg, css } = fix.filter;
  let out = '';
  // :is() forgives selectors this browser can't parse, so one bad entry doesn't drop the rule.
  if (invert.length) out += `:is(${invert.join(',')}){filter:invert(1) hue-rotate(180deg)!important}`;
  if (noInvert.length) out += `:is(${noInvert.join(',')}){filter:none!important}`;
  if (removeBg.length) out += `:is(${removeBg.join(',')}){background:none!important}`;
  return out + css;
}

function filterCss(t: Theme, fix: SiteFix | null, userCss = ''): string {
  const f =
    `invert(1) hue-rotate(180deg) brightness(${t.brightness / 100}) contrast(${t.contrast / 100})` +
    ` sepia(${t.sepia / 100}) grayscale(${t.grayscale / 100})`;
  return (
    '@media screen{' +
    `html{filter:${f}!important;background-color:#fff!important}` +
    // Invert media back so photos and video look normal...
    `:is(${MEDIA}){filter:invert(1) hue-rotate(180deg)!important}` +
    // ...but not twice when nested in an already re-inverted element.
    `[style*="background-image"] :is(${MEDIA}){filter:none!important}` +
    // Fullscreen content lives in the top layer, outside the root filter.
    `:fullscreen,:fullscreen :is(${MEDIA}){filter:none!important}` +
    fixCss(fix) +
    userCss +
    '}'
  );
}

/** Invert the whole page on the GPU. No per-rule work at all. */
export class FilterTheme {
  private sheet = new CSSStyleSheet();
  private readopt = () => this.adopt();
  private fix: SiteFix | null = null;
  private theme: Theme;
  private userCss = '';
  /** The filter is one stylesheet; its cost is building and adopting it. */
  cost = 0;

  constructor(theme: Theme) {
    this.theme = theme;
    this.sheet.replaceSync(filterCss(theme, null));
  }

  start() {
    const t0 = performance.now();
    this.adopt();
    this.cost += performance.now() - t0;
    document.addEventListener('__dusk_cssom', this.readopt);
  }

  stop() {
    document.removeEventListener('__dusk_cssom', this.readopt);
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet);
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.sheet.replaceSync(filterCss(theme, this.fix, this.userCss));
  }

  setFix(fix: SiteFix) {
    this.fix = fix;
    this.sheet.replaceSync(filterCss(this.theme, fix, this.userCss));
  }

  setUserFixes(css: string) {
    if (css === this.userCss) return;
    this.userCss = css;
    this.sheet.replaceSync(filterCss(this.theme, this.fix, css));
  }

  measureDark(withOurs: boolean): boolean {
    return withOurs ? renderedDark() : darkWithout([this.sheet]);
  }

  private adopt() {
    const list = document.adoptedStyleSheets;
    if (list[list.length - 1] !== this.sheet) {
      document.adoptedStyleSheets = [...list.filter((s) => s !== this.sheet), this.sheet];
    }
  }
}
