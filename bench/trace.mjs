// Where extension-attributed main-thread time goes: node bench/trace.mjs <url> [extDir]
// Sums the native work (style recalc, sheet parsing, layout...) nested inside extension calls.
import puppeteer from 'puppeteer';
import { resolve } from 'node:path';

const [url, ext = 'dist'] = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [resolve(ext)], defaultViewport: { width: 1280, height: 800 } });
await new Promise((r) => setTimeout(r, 2500));
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink'] });
await page.goto(url, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 3000));
const events = JSON.parse(new TextDecoder().decode(await page.tracing.stop())).traceEvents.filter((e) => e.ph === 'X' && e.dur);
await browser.close();

const isExt = (e) => String(e.args?.data?.url ?? e.args?.data?.scriptName ?? '').startsWith('chrome-extension://');
const roots = events.filter(isExt);
const byThread = new Map();
for (const e of events) {
  const k = `${e.pid}:${e.tid}`;
  if (!byThread.has(k)) byThread.set(k, []);
  byThread.get(k).push(e);
}
const inside = new Map();
let total = 0;
for (const r of roots) {
  total += r.dur;
  for (const e of byThread.get(`${r.pid}:${r.tid}`)) {
    if (e === r || e.ts < r.ts || e.ts + e.dur > r.ts + r.dur) continue;
    inside.set(e.name, (inside.get(e.name) ?? 0) + e.dur);
  }
}
console.log(`extension roots: ${roots.length}, total ${(total / 1000).toFixed(1)}ms (overlaps not merged)`);
for (const [name, dur] of [...inside].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log((dur / 1000).toFixed(1).padStart(8), name);
}
const top = roots.sort((a, b) => b.dur - a.dur).slice(0, 8);
for (const r of top) console.log('root', r.name, (r.dur / 1000).toFixed(1), r.args?.data?.functionName ?? '', String(r.args?.data?.url).split('/').pop());
