// CPU profile of extension code on one page: node bench/profile.mjs <url> [extDir]
import puppeteer from 'puppeteer';
import { resolve } from 'node:path';

const [url, ext = 'dist'] = process.argv.slice(2);
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [resolve(ext)], defaultViewport: { width: 1280, height: 800 } });
await new Promise((r) => setTimeout(r, 2500));
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36');
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
const cdp = await page.createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
await page.goto(url, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 3000));
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  const f = n.callFrame;
  if (!f.url.startsWith('chrome-extension://')) continue;
  const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
}
const rows = [...self].sort((a, b) => b[1] - a[1]);
console.log('total ext self ms', rows.reduce((s, [, v]) => s + v, 0).toFixed(1));
for (const [k, v] of rows.slice(0, 25)) console.log(v.toFixed(1).padStart(7), k);
await browser.close();
