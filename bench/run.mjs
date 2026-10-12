// Compares page cost and looks: no extension vs Dusk vs Dark Reader.
//   node bench/run.mjs [runs=3]
// Dark Reader's MV3 build is expected unpacked in bench/vendor/darkreader.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const RUNS = Number(process.argv[2] ?? 5);
const ALL_SITES = {
  wikipedia: 'https://en.wikipedia.org/wiki/Rust_(programming_language)',
  github: 'https://github.com/darkreader/darkreader',
  hn: 'https://news.ycombinator.com/',
  mdn: 'https://developer.mozilla.org/en-US/docs/Web/CSS/filter',
  python: 'https://docs.python.org/3/library/asyncio.html',
  bbc: 'https://www.bbc.com/news',
  stackoverflow: 'https://stackoverflow.com/questions/11227809',
  reddit: 'https://www.reddit.com/r/rust/',
};
const SITES = process.env.BENCH_SITES ? Object.fromEntries(Object.entries(ALL_SITES).filter(([k]) => process.env.BENCH_SITES.split(',').includes(k))) : ALL_SITES;
const CONFIGS = {
  none: null,
  dusk: resolve('dist'),
  darkreader: resolve('bench/vendor/darkreader'),
};
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const SETTLE_MS = 3000;

await mkdir('bench/out', { recursive: true });

/** Wall time the renderer main thread spent running extension scripts (overlaps merged). */
function extensionTime(trace) {
  const events = JSON.parse(trace).traceEvents;
  const intervals = [];
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue;
    const url = e.args?.data?.url ?? e.args?.data?.scriptName ?? '';
    if (typeof url === 'string' && url.startsWith('chrome-extension://')) intervals.push([e.ts, e.ts + e.dur]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of intervals) {
    if (s > end) {
      total += e - s;
      end = e;
    } else if (e > end) {
      total += e - end;
      end = e;
    }
  }
  return total / 1000;
}

async function measure(site, url, config, run) {
  const ext = CONFIGS[config];
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: ext ? [ext] : false,
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    // Give the extension's worker time to register its content scripts.
    if (ext) await new Promise((r) => setTimeout(r, 2500));
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    // People reach for a dark-mode extension when sites render light.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    const cdp = await page.createCDPSession();
    await cdp.send('Performance.enable');
    await page.tracing.start({ categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute'] });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const trace = await page.tracing.stop();
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
    // Bot checks and block pages measure nothing; throw the run away.
    const blocked = await page.evaluate(
      () => /just a moment|verify you are human|access denied|blocked|captcha|attention required/i.test(document.title) || (document.body?.innerText.length ?? 0) < 400,
    );
    if (run === 0 && !blocked) await page.screenshot({ path: `bench/out/${site}-${config}.png` });
    if (blocked) return null;
    return {
      ext: extensionTime(new TextDecoder().decode(trace)),
      task: m.TaskDuration * 1000,
      style: m.RecalcStyleDuration * 1000,
      script: m.ScriptDuration * 1000,
      heap: m.JSHeapUsedSize / 1e6,
      fcp,
      wall: Date.now() - t0,
    };
  } finally {
    await browser.close();
  }
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

const results = {};
for (const [site, url] of Object.entries(SITES)) {
  // Interleave configurations within each round, in shuffled order, so a slow
  // minute on the site lands on all of them instead of skewing one.
  const runs = Object.fromEntries(Object.keys(CONFIGS).map((c) => [c, []]));
  for (let i = 0; i < RUNS; i++) {
    const order = Object.keys(CONFIGS).sort(() => Math.random() - 0.5);
    for (const config of order) {
      const r = await measure(site, url, config, runs[config].length === 0 ? 0 : 1);
      if (r) runs[config].push(r);
    }
  }
  results[site] = {};
  for (const config of Object.keys(CONFIGS)) {
    const list = runs[config];
    if (!list.length) {
      console.log(`${site.padEnd(14)} ${config.padEnd(11)} no valid runs (bot check)`);
      continue;
    }
    const agg = { runs: list.length };
    for (const k of Object.keys(list[0])) agg[k] = median(list.map((r) => r[k]));
    results[site][config] = agg;
    const f = (x) => (x == null ? '-' : x.toFixed(1));
    console.log(
      `${site.padEnd(14)} ${config.padEnd(11)} ext ${f(agg.ext).padStart(7)}ms  style ${f(agg.style).padStart(7)}ms  task ${f(agg.task).padStart(7)}ms  runs ${list.length}`,
    );
  }
}
await writeFile('bench/out/results.json', JSON.stringify(results, null, 2));

// Side-by-side sheet per site for eyeballing.
const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1920, height: 440 } });
const page = await browser.newPage();
for (const site of Object.keys(SITES)) {
  let cells = '';
  for (const c of Object.keys(CONFIGS)) {
    const img = (await readFile(`bench/out/${site}-${c}.png`)).toString('base64');
    cells += `<figure><img src="data:image/png;base64,${img}"><figcaption>${c}</figcaption></figure>`;
  }
  await page.setContent(
    `<style>body{margin:0;display:flex;gap:8px;background:#444;font:16px system-ui;color:#fff}figure{margin:0;flex:1}img{width:100%;display:block}figcaption{padding:4px}</style>${cells}`,
  );
  await page.screenshot({ path: `bench/out/${site}-compare.png` });
}
await browser.close();
