export type RGBA = { r: number; g: number; b: number; a: number };
export type Role = 'bg' | 'fg' | 'bd';

export interface Theme {
  brightness: number;
  contrast: number;
  sepia: number;
  grayscale: number;
  /** What white backgrounds and black text turn into; neutral grays take on their tint. */
  bgColor: string;
  fgColor: string;
}

export const DEFAULT_THEME: Theme = {
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  bgColor: '#181a1b',
  fgColor: '#e8e6e3',
};

const NAMED_SRC =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 ' +
  'black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 ' +
  'chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff ' +
  'darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 ' +
  'darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 ' +
  'darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f ' +
  'darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 ' +
  'dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 ' +
  'honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa ' +
  'lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff ' +
  'lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 ' +
  'lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 ' +
  'mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 ' +
  'mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 ' +
  'midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 ' +
  'oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
  'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f ' +
  'pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f ' +
  'royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee ' +
  'sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
  'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 ' +
  'violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32';

const NAMED = new Map<string, number>();
{
  const parts = NAMED_SRC.split(' ');
  for (let i = 0; i < parts.length; i += 2) NAMED.set(parts[i], parseInt(parts[i + 1], 16));
}

export function isNamedColor(word: string): boolean {
  return NAMED.has(word.toLowerCase());
}

export function parseHex(hex: string): RGBA | null {
  const h = hex.slice(1);
  const n = h.length;
  if (n === 3 || n === 4) {
    const v = [...h].map((c) => parseInt(c + c, 16));
    return { r: v[0], g: v[1], b: v[2], a: n === 4 ? v[3] / 255 : 1 };
  }
  if (n === 6 || n === 8) {
    const v = parseInt(h, 16);
    if (Number.isNaN(v)) return null;
    return n === 6
      ? { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 }
      : { r: (v >>> 24) & 255, g: (v >> 16) & 255, b: (v >> 8) & 255, a: (v & 255) / 255 };
  }
  return null;
}

export function parseNamed(word: string): RGBA | null {
  const v = NAMED.get(word.toLowerCase());
  return v === undefined ? null : { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
}

function num(s: string, scale: number): number {
  if (s === 'none') return 0;
  return s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s);
}

function hue(s: string): number {
  const v = parseFloat(s);
  if (s.endsWith('turn')) return v * 360;
  if (s.endsWith('grad')) return v * 0.9;
  if (s.endsWith('rad')) return (v * 180) / Math.PI;
  return s === 'none' ? 0 : v;
}

/**
 * rgb()/hsl() arguments. When only the alpha is a var() (Tailwind's
 * `rgb(255 255 255 / var(--tw-bg-opacity))`) the expression is kept as is.
 */
export function parseFunc(name: string, args: string): { color: RGBA; alphaExpr?: string } | null {
  const slash = args.indexOf('/');
  const main = (slash >= 0 ? args.slice(0, slash) : args).trim().split(/[\s,]+/);
  let alphaSrc = slash >= 0 ? args.slice(slash + 1).trim() : main.length === 4 ? main.pop()! : '';
  if (main.length !== 3 || main.some((p) => p.includes('var('))) return null;
  let alphaExpr: string | undefined;
  let a = 1;
  if (alphaSrc.includes('var(') || alphaSrc.includes('calc(')) alphaExpr = alphaSrc;
  else if (alphaSrc) a = num(alphaSrc, 1);
  let color: RGBA;
  if (name.startsWith('rgb')) {
    color = { r: num(main[0], 255), g: num(main[1], 255), b: num(main[2], 255), a };
  } else {
    color = { ...hslToRgb(hue(main[0]), num(main[1], 1) / (main[1].endsWith('%') ? 1 : 100), num(main[2], 1) / (main[2].endsWith('%') ? 1 : 100)), a };
  }
  if ([color.r, color.g, color.b, color.a].some(Number.isNaN)) return null;
  return { color, alphaExpr };
}

let canvas: OffscreenCanvasRenderingContext2D | null | undefined;

/** Any other CSS color syntax (oklch, lab, color(), ...) resolved by the browser. */
export function parseViaCanvas(value: string): RGBA | null {
  if (canvas === undefined) {
    canvas = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  }
  if (!canvas) return null;
  const sentinel = 'rgba(1, 2, 3, 0.004)';
  canvas.fillStyle = sentinel;
  canvas.fillStyle = value;
  if (canvas.fillStyle === sentinel || canvas.fillStyle === '#010203') return null;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

export function parseColor(value: string): RGBA | null {
  const v = value.trim();
  if (v[0] === '#') return parseHex(v);
  const m = /^([a-z-]+)\((.*)\)$/i.exec(v);
  if (m) {
    const name = m[1].toLowerCase();
    if (name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla') return parseFunc(name, m[2])?.color ?? null;
    return parseViaCanvas(v);
  }
  if (v.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return parseNamed(v);
}

export function rgbToHsl({ r, g, b }: RGBA): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGBA {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 };
}

/** Relative luminance, 0..1. */
export function luminance({ r, g, b }: RGBA): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Light backgrounds become dark, dark text becomes light, borders land in
 * between. Colors already on the "right" side are mostly left alone, which
 * keeps the transform close to idempotent on sites that are partly dark.
 */
function shiftLightness(h: number, s: number, l: number, role: Role, bgL: number, fgL: number): number {
  if (role === 'bg') return l > 0.5 ? bgL + (1 - l) * 0.4 : Math.min(l, bgL + 0.2);
  if (role === 'fg') {
    // Saturated blues look much darker than their HSL lightness says.
    const floor = s > 0.4 && h > 200 && h < 280 ? 0.75 : 0.6;
    return l < 0.5 ? Math.max(floor, fgL - l * 0.56) : Math.max(l, floor);
  }
  return bgL + 0.1 + (1 - l) * 0.3;
}

const anchors = new Map<string, [number, number, number]>();
function anchor(color: string, fallback: string): [number, number, number] {
  let a = anchors.get(color);
  if (!a) anchors.set(color, (a = rgbToHsl(parseHex(color) ?? parseHex(fallback)!)));
  return a;
}

function applyFilters(c: RGBA, t: Theme): RGBA {
  let { r, g, b } = c;
  if (t.sepia) {
    const k = t.sepia / 100;
    const sr = r * 0.393 + g * 0.769 + b * 0.189;
    const sg = r * 0.349 + g * 0.686 + b * 0.168;
    const sb = r * 0.272 + g * 0.534 + b * 0.131;
    r += (sr - r) * k;
    g += (sg - g) * k;
    b += (sb - b) * k;
  }
  if (t.grayscale) {
    const k = t.grayscale / 100;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    r += (y - r) * k;
    g += (y - g) * k;
    b += (y - b) * k;
  }
  const br = t.brightness / 100;
  const ct = t.contrast / 100;
  const adj = (v: number) => Math.min(255, Math.max(0, ((v * br) / 255 - 0.5) * ct * 255 + 127.5));
  return { r: adj(r), g: adj(g), b: adj(b), a: c.a };
}

export function modify(c: RGBA, role: Role, t: Theme): RGBA {
  const bg = anchor(t.bgColor, DEFAULT_THEME.bgColor);
  const fg = anchor(t.fgColor, DEFAULT_THEME.fgColor);
  let [h, s, l] = rgbToHsl(c);
  const nl = shiftLightness(h, s, l, role, bg[2], fg[2]);
  if (s < 0.1) [h, s] = role === 'fg' ? fg : bg;
  const out = hslToRgb(h, s, nl);
  out.a = c.a;
  return applyFilters(out, t);
}

export function serialize({ r, g, b, a }: RGBA, alphaExpr?: string): string {
  const R = Math.round(r);
  const G = Math.round(g);
  const B = Math.round(b);
  if (alphaExpr) return `rgb(${R} ${G} ${B} / ${alphaExpr})`;
  if (a >= 1) return '#' + ((1 << 24) | (R << 16) | (G << 8) | B).toString(16).slice(1);
  return `rgba(${R},${G},${B},${Math.round(a * 1000) / 1000})`;
}

/** The first color written in a value like `url(x) #fff no-repeat`; null if there is none. */
export function firstColor(value: string): RGBA | null {
  const re = /url\([^)]*\)|#[\da-f]{3,8}(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\((?:[^()]|\([^()]*\))*\)|(?<![\w-])[a-z]+(?![\w(-])/gi;
  for (const [m] of value.matchAll(re)) {
    if (m.startsWith('url(')) continue;
    const c = parseColor(m);
    if (c) return c;
  }
  return null;
}
