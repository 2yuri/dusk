// What Dusk does on real sites, and what it costs: node bench/survey.mjs
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const SITES = process.argv.length > 2 ? process.argv.slice(2) : [
  'tailwindcss.com', 'nextjs.org', 'vercel.com', 'react.dev', 'vuejs.org', 'svelte.dev', 'astro.build', 'docusaurus.io',
  'getbootstrap.com', 'deno.com', 'bun.sh', 'supabase.com', 'ui.shadcn.com', 'prisma.io', 'nuxt.com', 'vite.dev',
  'tauri.app', 'docs.github.com', 'developer.mozilla.org/en-US/docs/Web/CSS', 'stackoverflow.com', 'en.wikipedia.org/wiki/Dusk',
  'news.ycombinator.com', 'github.com/darkreader/darkreader', 'www.reddit.com/r/rust/', 'www.bbc.com/news', 'docs.python.org/3/',
  'go.dev', 'www.rust-lang.org', 'kotlinlang.org', 'www.typescriptlang.org',
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [resolve('dist')], defaultViewport: { width: 1280, height: 800 } });
const worker = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
await new Promise((r) => setTimeout(r, 1500));
const rows = [];
for (const site of SITES) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  let row = { site, status: 'load-failed' };
  try {
    await page.goto(`https://${site}`, { waitUntil: 'load', timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    const report = await worker.evaluate(async (host) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(host));
      return tab && chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 }).catch(() => null);
    }, site.split('/')[0]);
    row = { site, ...(report ?? { status: 'no-report' }) };
  } catch (e) {
    row.error = String(e.message).slice(0, 60);
  }
  rows.push(row);
  console.log(`${site.padEnd(42)} ${String(row.status).padEnd(13)} ${String(row.native ?? '').padEnd(7)} ${row.cost != null ? row.cost.toFixed(1) + ' ms' : ''}`);
  if (process.argv.length > 2) console.log('   hooks', JSON.stringify(row.hooks), 'rejected', JSON.stringify(row.rejected));
  await page.close();
}
await writeFile('bench/out/survey.json', JSON.stringify(rows, null, 2));
const count = (f) => rows.filter(f).length;
console.log(`\nown theme via toggle: ${count((r) => r.native === 'toggle')}, via prefers-color-scheme: ${count((r) => r.native === 'media')}, rewritten: ${count((r) => r.status === 'dynamic')}, already dark: ${count((r) => r.status === 'already-dark')}, other: ${count((r) => !['native', 'dynamic', 'already-dark'].includes(r.status))}`);
await browser.close();
