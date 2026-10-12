import { DEFAULT_THEME, firstColor, luminance, modify, type RGBA, type Theme } from './color.ts';

/**
 * Background-image analysis. Runs in the background worker, so decoding and
 * pixel work never touch the page's main thread.
 *
 * Only one case is changed: dark artwork on a transparent background (icons,
 * logos drawn as CSS backgrounds), which would vanish on a dark page. It is
 * recolored with the same palette as text. Photos and large images are left
 * alone.
 */

const MAX_PIXELS = 512 * 512;
const MAX_BYTES = 200_000;
const SAMPLE = 64;

/** A replacement data URL, or null to keep the image as it is. */
export type Verdict = string | null;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Share of transparent pixels and, among the visible ones, of dark ones. */
function stats(data: Uint8ClampedArray): { transparent: number; dark: number } {
  let transparent = 0;
  let visible = 0;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 25) {
      transparent++;
      continue;
    }
    visible++;
    if (luminance({ r: data[i], g: data[i + 1], b: data[i + 2], a: 1 }) < 0.1) dark++;
  }
  const total = data.length / 4;
  return { transparent: transparent / total, dark: visible ? dark / visible : 0 };
}

const isDarkIcon = (s: { transparent: number; dark: number }) => s.transparent >= 0.1 && s.dark >= 0.7;

async function analyzeBitmap(blob: Blob, theme: Theme): Promise<Verdict> {
  const bitmap = await createImageBitmap(blob);
  const { width: w, height: h } = bitmap;
  if (!w || !h || w * h > MAX_PIXELS) return null;

  const sw = Math.min(w, SAMPLE);
  const sh = Math.min(h, SAMPLE);
  const probe = new OffscreenCanvas(sw, sh).getContext('2d', { willReadFrequently: true })!;
  probe.drawImage(bitmap, 0, 0, sw, sh);
  if (!isDarkIcon(stats(probe.getImageData(0, 0, sw, sh).data))) return null;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const memo = new Map<number, RGBA>();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let c = memo.get(key);
    if (!c) memo.set(key, (c = modify({ r: d[i], g: d[i + 1], b: d[i + 2], a: 1 }, 'fg', theme)));
    d[i] = c.r;
    d[i + 1] = c.g;
    d[i + 2] = c.b;
  }
  ctx.putImageData(img, 0, 0);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  return 'data:image/png;base64,' + toBase64(new Uint8Array(await png.arrayBuffer()));
}

/**
 * SVGs can't be decoded in a worker, so read the markup: if every color it
 * paints with is dark (or it sets none, which paints black), it's a dark
 * icon. The fix is a filter on its root element.
 */
function analyzeSvg(text: string): Verdict {
  if (text.length > MAX_BYTES || /<(image|foreignObject)\b/i.test(text)) return null;
  const paints = [...text.matchAll(/\b(?:fill|stroke|stop-color|color)\s*[=:]\s*["']?\s*([^"';>]+)/gi)]
    .map((m) => m[1].trim())
    .filter((v) => !/^(none|inherit|transparent|url\()/i.test(v))
    // An SVG shown as an image has no inherited color: currentColor paints black.
    .map((v) => (/^currentcolor$/i.test(v) ? '#000' : v));
  const colors = paints.map((p) => firstColor(p)).filter((c): c is RGBA => c !== null && c.a > 0.1);
  const unset = !/\bfill\s*[=:]/i.test(text);
  if (!unset && (!colors.length || colors.filter((c) => luminance(c) < 0.1).length / colors.length < 0.7)) return null;
  const svg = text.replace(/<svg\b/i, '<svg style="filter:invert(1) hue-rotate(180deg)"');
  return 'data:image/svg+xml;base64,' + toBase64(new TextEncoder().encode(svg));
}

export async function analyze(url: string, theme: Theme = DEFAULT_THEME): Promise<Verdict> {
  if (!/^(https?:|data:image\/)/i.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > MAX_BYTES * 5) return null;
    if (blob.type.includes('svg') || /\.svg(\?|#|$)/i.test(url)) return analyzeSvg(await blob.text());
    if (!blob.type.startsWith('image/')) return null;
    return await analyzeBitmap(blob, theme);
  } catch {
    return null;
  }
}
