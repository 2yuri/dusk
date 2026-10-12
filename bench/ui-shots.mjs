// Screenshots of every implemented view, for comparison with design/dusk.mat.
//   node bench/ui-shots.mjs   -> bench/out/ui/*.png
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const OUT = 'bench/out/ui';
await mkdir(OUT, { recursive: true });

const pages = {
  'light.html': '<!doctype html><title>light</title><style>body{background:#fff;color:#111}</style><p>light page</p>',
  'dark.html': '<!doctype html><title>dark</title><style>body{background:#111;color:#eee}</style><p>dark page</p>',
  // The picker demo page from the design, as a light site that Dusk then darkens.
  'acme.html': `<!doctype html><meta charset="utf-8"><title>acme</title><style>
    body{margin:0;background:#fff;color:#2a2a2e;font:16px/1.6 Inter,system-ui,sans-serif}
    nav{display:flex;align-items:center;gap:32px;height:64px;padding:0 48px;border-bottom:1px solid #e8e8ec}
    .site-logo{display:block;width:112px;height:28px}
    nav a{color:#3a3a40;text-decoration:none;font-size:14px}nav span{flex:1}nav button{padding:8px 14px;border:1px solid #d4d4d8;border-radius:8px;background:none;font:500 13px Inter,system-ui}
    main{display:flex;gap:56px;padding:56px 48px}article{width:560px}h1{font:700 40px/1.1 Inter,system-ui;letter-spacing:-1.2px;margin:12px 0 16px;color:#111}
    .k{font:12px ui-monospace,monospace;letter-spacing:.5px;color:#777}.chart{width:520px;height:330px;border-radius:10px}
  </style><nav><img class="site-logo" alt="acme.dev" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="112" height="28"><text x="0" y="22" font-family="Georgia,serif" font-weight="700" font-size="24" fill="#26262b">acme·dev</text></svg>')}"><a href="#">Docs</a><a href="#">Pricing</a><a href="#">Blog</a><a href="#">Changelog</a><span></span><button>Sign in</button></nav>
  <main><article><div class="k">ENGINEERING · OCT 2026</div><h1>How we cut cold starts by 61%</h1><p>Our functions used to spend most of their first request loading code they never ran. We split bundles by route, moved config parsing to build time, and warmed the two hottest paths on deploy.</p><p>The chart shows p95 cold-start latency per region before and after the change.</p></article>
  <img class="chart" alt="" src="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="520" height="330"><rect width="520" height="330" fill="#fff"/><g fill="#2563eb"><rect x="60" y="90" width="50" height="200"/><rect x="140" y="140" width="50" height="150"/><rect x="220" y="158" width="50" height="132"/><rect x="300" y="210" width="50" height="80"/><rect x="380" y="230" width="50" height="60"/></g></svg>')}"></main>`,
  'lock.html': '<!doctype html><title>lock</title><meta name="darkreader-lock"><style>body{background:#fff}</style><p>locked</p>',
};
const server = createServer((req, res) => {
  const body = pages[req.url.slice(1)];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? '');
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [resolve('dist')] });
const worker = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
const extId = new URL(worker.url()).host;
const set = (patch) => worker.evaluate(async (p) => { await chrome.storage.sync.clear(); await chrome.storage.sync.set(p); }, patch);
const sites = { 'bbc.com': 'dynamic', 'docs.python.org': 'dynamic', 'figma.com': 'off', 'linear.app': 'off', 'mail.google.com': 'filter', 'news.ycombinator.com': 'filter' };

async function tabFor(url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'load' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  const id = await worker.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, url.split('#')[0]);
  return { page, id };
}

async function popup(name, url, settings) {
  await set(settings);
  const { page, id } = await tabFor(url);
  const p = await browser.newPage();
  await p.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await p.goto(`chrome-extension://${extId}/popup.html${id ? `?tab=${id}` : ''}`);
  await new Promise((r) => setTimeout(r, 600));
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await p.close();
  await page.close();
}

await popup('popup-active', `${base}/light.html`, { siteModes: {} });
await popup('popup-already-dark', `${base}/dark.html`, {});
await popup('popup-off', `${base}/light.html`, { enabled: false });
await popup('popup-unsupported', 'about:blank', {});
await popup('popup-opted-out', `${base}/lock.html`, {});

// Picker: choosing, the action menu, applied.
await set({});
{
  const { page, id } = await tabFor(`${base}/acme.html`);
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
  await new Promise((r) => setTimeout(r, 500));
  await worker.evaluate(async (tid) => {
    await chrome.scripting.executeScript({ target: { tabId: tid, frameIds: [0] }, files: ['picker.js'] });
    await chrome.tabs.sendMessage(tid, { type: 'pick' }, { frameId: 0 });
  }, id);
  await new Promise((r) => setTimeout(r, 600));
  const box = await (await page.$('.site-logo')).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}/picker-choosing.png` });
  await page.mouse.click(box.x + 20, box.y + 10);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${OUT}/picker-menu.png` });
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/picker-applied.png` });
  await page.close();
}

await set({
  siteModes: sites,
  contrast: 110,
  sepia: 10,
  automation: 'time',
  userFixes: { 'acme.dev': [['img.site-logo', 'invert'], ['figure.chart > img', 'dim']], 'status.example.com': [['header .brand svg', 'invert']] },
});
const o = await browser.newPage();
await o.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
await o.goto(`chrome-extension://${extId}/options.html`);
await new Promise((r) => setTimeout(r, 800));
await o.screenshot({ path: `${OUT}/options.png`, fullPage: true });
await o.click('#addSite');
await o.type('#newHost', 'notion.so');
await o.select('#newMode', 'filter');
await new Promise((r) => setTimeout(r, 200));
await (await o.$('#sites')).screenshot({ path: `${OUT}/options-adding.png` });
await set({});
await new Promise((r) => setTimeout(r, 400));
await o.click('#cancelSite');
await (await o.$('#sites')).screenshot({ path: `${OUT}/options-empty.png` });
await (await o.$('#fixes')).screenshot({ path: `${OUT}/options-fixes-empty.png` });

await browser.close();
server.close();
console.log('ok');
