// Loads dist/ into Chrome for Testing and checks computed colors on fixture pages.
// Run `npm run build` first.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';
import { pages } from './fixtures.mjs';

let browser;
let worker;
let base;
const servers = [];

function serve(rewrite) {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const name = req.url.slice(1).split('?')[0];
      const body = pages[name];
      if (body === undefined) return res.writeHead(404).end();
      const type = { css: 'text/css', svg: 'image/svg+xml', png: 'image/png' }[name.split('.').pop()] ?? 'text/html';
      res.writeHead(200, { 'content-type': type });
      res.end(typeof body === 'string' ? rewrite(body) : body);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => ok(server.address().port));
  });
}

before(async () => {
  const crossPort = await serve((b) => b);
  // Page on "localhost", stylesheet on "127.0.0.1": different origins.
  const pagePort = await serve((b) => b.replaceAll('CROSS', `http://127.0.0.1:${crossPort}`));
  base = `http://localhost:${pagePort}`;
  browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [resolve('dist')] });
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  worker = await target.worker();
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function settings(patch) {
  await worker.evaluate(async (p) => {
    await chrome.storage.sync.clear();
    await chrome.storage.local.clear();
    await chrome.storage.sync.set(p);
  }, patch);
  // Let the worker re-register content scripts.
  await new Promise((r) => setTimeout(r, 300));
}

async function open(name) {
  const tab = await browser.newPage();
  await tab.goto(`${base}/${name}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 400));
  return tab;
}

/** Luminance of a computed color property, in the page. */
function lum(tab, selector, prop, pseudoRoot) {
  return tab.evaluate(
    (sel, prop, pseudoRoot) => {
      let el;
      if (pseudoRoot) el = document.querySelector(pseudoRoot).shadowRoot.querySelector(sel);
      else el = document.querySelector(sel);
      const v = getComputedStyle(el)[prop];
      const m = v.match(/[\d.]+/g).map(Number);
      const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
    },
    selector,
    prop,
    pseudoRoot,
  );
}

const css = (tab, selector, prop) => tab.evaluate((s, p) => getComputedStyle(document.querySelector(s))[p], selector, prop);

const DARK = 0.05;
const LIGHT = 0.4;

test('defaults', async (t) => {
  await settings({});

  await t.test('plain stylesheet', async () => {
    const tab = await open('basic.html');
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#card', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#p', 'color')) > LIGHT);
    assert.ok((await lum(tab, '#a', 'color')) > 0.2);
    await tab.close();
  });

  await t.test('CSS variables, including aliases', async () => {
    const tab = await open('vars.html');
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, 'body', 'color')) > LIGHT);
    assert.ok((await lum(tab, '#box', 'backgroundColor')) < DARK);
    await tab.close();
  });

  await t.test('inline styles and presentation attributes', async () => {
    const tab = await open('inline.html');
    assert.ok((await lum(tab, '#d', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#d', 'color')) > LIGHT);
    assert.ok((await lum(tab, '#path', 'fill')) > LIGHT);
    assert.ok((await lum(tab, '#td', 'backgroundColor')) < DARK);
    // No attributes were added to the page's elements.
    assert.equal(await tab.evaluate(() => document.querySelectorAll('[data-dusk]').length), 0);
    await tab.close();
  });

  await t.test('cross-origin stylesheet', async () => {
    const tab = await open('cross.html');
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#x', 'color')) > LIGHT);
    await tab.close();
  });

  await t.test('rules inserted through the CSSOM (CSS-in-JS)', async () => {
    const tab = await open('cssinjs.html');
    assert.ok((await lum(tab, '#late', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#late', 'color')) > LIGHT);
    await tab.close();
  });

  await t.test('shadow DOM: style, adoptedStyleSheets, declarative', async () => {
    const tab = await open('shadow.html');
    assert.ok((await lum(tab, '.in', 'backgroundColor', '#host')) < DARK);
    assert.ok((await lum(tab, '.in', 'color', '#host')) > LIGHT);
    assert.ok((await lum(tab, '.adopted', 'backgroundColor', '#host')) < DARK);
    assert.ok((await lum(tab, '.d', 'backgroundColor', '#dsd')) < DARK);
    // The page's own adopted sheet is still there.
    assert.ok(await tab.evaluate(() => document.querySelector('#host').shadowRoot.adoptedStyleSheets.length >= 2));
    await tab.close();
  });

  await t.test('already-dark site is left untouched', async () => {
    const tab = await open('dark.html');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(18, 18, 18)');
    assert.equal(await tab.evaluate(() => document.adoptedStyleSheets.length), 0);
    await tab.close();
  });

  await t.test("site's own dark theme is used when it has one", async () => {
    const tab = await open('native.html');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(18, 52, 86)');
    assert.equal(await css(tab, '.n0', 'color'), 'rgb(250, 250, 250)');
    await tab.close();
  });

  await t.test('inline styles still apply when the native theme is rejected', async () => {
    const tab = await open('native-rejected.html');
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#ib', 'backgroundColor')) < DARK);
    await tab.close();
  });

  await t.test('already-dark detection reads variables and theme classes', async () => {
    for (const [name, bg] of [
      ['dark-var.html', 'rgb(13, 17, 23)'],
      ['dark-class.html', 'rgb(17, 17, 17)'],
    ]) {
      const tab = await open(name);
      assert.equal(await css(tab, 'body', 'backgroundColor'), bg, name);
      // Rewriting a dark color barely changes it, so check that nothing was applied at all.
      assert.equal(await tab.evaluate(() => document.adoptedStyleSheets.length), 0, name);
      await tab.close();
    }
  });

  await t.test("a dark theme behind the site's own toggle is switched on", async () => {
    let tab = await open('toggle-class.html');
    assert.ok(await tab.evaluate(() => document.documentElement.classList.contains('dark')));
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(11, 11, 15)');
    assert.equal(await css(tab, '#card', 'backgroundColor'), 'rgb(28, 28, 34)', "the site's own dark color, not ours");
    await tab.close();

    tab = await open('toggle-attr.html');
    assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(16, 16, 20)');
    await tab.close();
  });

  await t.test('a ".dark" that is only a component variant is tried and rejected', async () => {
    const tab = await open('toggle-false.html');
    assert.ok(!(await tab.evaluate(() => document.documentElement.classList.contains('dark'))));
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK, 'falls back to rewriting colors');
    await tab.close();
  });

  await t.test('the hook survives a hydration reset', async () => {
    const tab = await open('toggle-hydrate.html');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await tab.evaluate(() => document.documentElement.classList.contains('dark')));
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(11, 11, 15)');
    await tab.close();
  });

  await t.test('turning Dusk off restores the theme attribute the site had', async () => {
    const tab = await open('toggle-attr.html');
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await tab.evaluate(() => document.documentElement.dataset.theme), 'light');
    await worker.evaluate(() => chrome.storage.sync.set({ enabled: true }));
    await tab.close();
  });

  await t.test('theme variables set inline by script (Outlook)', async () => {
    const tab = await open('inline-vars.html');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await lum(tab, '#app', 'backgroundColor')) < DARK, 'app surface');
    assert.ok((await lum(tab, '#app', 'color')) > LIGHT, 'app text');
    assert.ok((await lum(tab, '#row', 'backgroundColor')) < DARK, 'row');
    assert.ok((await lum(tab, '#late', 'backgroundColor')) < DARK, 'variable added later with setProperty');
    await tab.close();
  });

  await t.test('darkreader-lock is respected', async () => {
    const tab = await open('lock.html');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(255, 255, 255)');
    await tab.close();
  });

  await t.test('Tailwind opacity variables', async () => {
    const tab = await open('tailwind.html');
    assert.ok((await lum(tab, '#tw', 'backgroundColor')) < DARK);
    await tab.close();
  });

  await t.test('gradients, @media, @layer, shorthand with var()', async () => {
    const tab = await open('misc.html');
    const g = await css(tab, '#g', 'backgroundImage');
    assert.ok(!g.includes('255, 255, 255'), g);
    assert.ok((await lum(tab, '#m', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#l', 'backgroundColor')) < DARK);
    assert.ok((await lum(tab, '#sh', 'borderTopColor')) < 0.2);
    await tab.close();
  });

  await t.test('dark icons drawn as backgrounds are recolored; photos are not', async () => {
    const tab = await open('images.html');
    await new Promise((r) => setTimeout(r, 600));
    assert.match(await css(tab, '#svg', 'backgroundImage'), /data:image\/svg\+xml/);
    assert.match(await css(tab, '#png', 'backgroundImage'), /data:image\/png/);
    assert.match(await css(tab, '#photo', 'backgroundImage'), /photo\.png/);
    await tab.close();
  });

  await t.test('elements added later', async () => {
    const tab = await open('dynamic.html');
    await tab.waitForSelector('#added');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok((await lum(tab, '#added', 'backgroundColor')) < DARK);
    await tab.close();
  });

  await t.test('repeat visit applies cached CSS', async () => {
    const first = await open('basic.html');
    await new Promise((r) => setTimeout(r, 2500));
    await first.close();
    const cached = await worker.evaluate(async (origin) => (await chrome.storage.local.get('c:' + origin))['c:' + origin], base);
    assert.equal(cached?.kind, 'transform');
    assert.ok(cached.css.includes('.card{'));
  });
});

test('per-site modes', async (t) => {
  await t.test('filter', async () => {
    await settings({ siteModes: { localhost: 'filter' } });
    const tab = await open('basic.html');
    assert.match(await css(tab, 'html', 'filter'), /invert/);
    await tab.close();
  });

  await t.test('off', async () => {
    await settings({ siteModes: { localhost: 'off' } });
    const tab = await open('basic.html');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(255, 255, 255)');
    await tab.close();
  });

  await t.test('live toggle without reload', async () => {
    await settings({});
    const tab = await open('basic.html');
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    await worker.evaluate(() => chrome.storage.sync.set({ siteModes: { localhost: 'off' } }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(255, 255, 255)');
    await worker.evaluate(() => chrome.storage.sync.set({ siteModes: {} }));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await lum(tab, 'body', 'backgroundColor')) < DARK);
    await tab.close();
  });

  await t.test('globally disabled', async () => {
    await settings({ enabled: false });
    const tab = await open('basic.html');
    assert.equal(await css(tab, 'body', 'backgroundColor'), 'rgb(255, 255, 255)');
    await tab.close();
  });
});

test('options page and popup', async (t) => {
  const extId = new URL(worker.url()).host;
  const sync = () => worker.evaluate(() => chrome.storage.sync.get(null));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await t.test('add, change and remove a site', async () => {
    await settings({});
    const o = await browser.newPage();
    await o.goto(`chrome-extension://${extId}/options.html#sites`);
    await wait(300);
    await o.click('#addSite');
    await o.type('#newHost', 'https://Notion.so/some/page');
    await o.select('#newMode', 'filter');
    await o.click('#newSite button[type="submit"]');
    await wait(200);
    assert.deepEqual((await sync()).siteModes, { 'notion.so': 'filter' });
    await o.select('#siteList select', 'off');
    await wait(200);
    assert.deepEqual((await sync()).siteModes, { 'notion.so': 'off' });
    await o.click('#siteList .icon-btn');
    await wait(200);
    assert.deepEqual((await sync()).siteModes, {});
    assert.match(await o.$eval('#siteList', (el) => el.textContent), /No sites yet/);
    // Garbage is refused with a message, not saved.
    await o.click('#addSite');
    await o.type('#newHost', 'not a site');
    await o.click('#newSite button[type="submit"]');
    await wait(100);
    assert.equal(await o.$eval('#siteError', (el) => el.hidden), false);
    assert.deepEqual((await sync()).siteModes, {});
    await o.close();
  });

  await t.test('import keeps only valid settings; clear cache empties it', async () => {
    await settings({});
    await worker.evaluate(() => chrome.storage.local.set({ 'c:https://a.test': { kind: 'transform', css: 'x' }, cacheIndex: { 'c:https://a.test': 1 } }));
    const o = await browser.newPage();
    await o.goto(`chrome-extension://${extId}/options.html#about`);
    await wait(400);
    assert.match(await o.$eval('#cacheInfo', (el) => el.textContent), /1 site/);
    const input = await o.$('#importFile');
    const file = resolve('bench/out/import-test.json');
    await (await import('node:fs/promises')).writeFile(
      file,
      JSON.stringify({ dusk: 1, settings: { contrast: 120, siteModes: { 'Example.com': 'filter', bad: 'nope' }, evil: 'x', enabled: 'yes' } }),
    );
    await input.uploadFile(file);
    await wait(300);
    const s = await sync();
    assert.equal(s.contrast, 120);
    assert.deepEqual(s.siteModes, { 'example.com': 'filter' });
    assert.equal(s.evil, undefined);
    assert.equal(s.enabled, undefined, 'wrong types are dropped');
    await o.click('#clearCache');
    await wait(200);
    const local = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(Object.keys(local), []);
    await o.close();
  });

  await t.test('popup: "Darken anyway" on an already-dark site', async () => {
    await settings({});
    const page = await open('dark.html');
    const id = await worker.evaluate(async () => (await chrome.tabs.query({})).find((x) => x.url?.includes('dark.html'))?.id);
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${id}`);
    await wait(400);
    assert.match(await p.$eval('#status', (el) => el.textContent), /Already dark/);
    await p.click('#darken');
    await wait(500);
    assert.deepEqual((await sync()).siteModes, { localhost: 'dynamic' });
    assert.ok(await page.evaluate(() => document.adoptedStyleSheets.length > 0), 'page is darkened now');
    await p.close();
    await page.close();
  });

  await t.test('"Leave dark sites alone" off: auto mode darkens dark sites too', async () => {
    await settings({ detectDark: false });
    const tab = await open('dark.html');
    assert.ok(await tab.evaluate(() => document.adoptedStyleSheets.length > 0));
    await tab.close();
  });
});

test('contrast, picker and page report', async (t) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sync = () => worker.evaluate(() => chrome.storage.sync.get(null));
  const report = (file) =>
    worker.evaluate(async (f) => {
      const tab = (await chrome.tabs.query({})).find((x) => x.url?.includes(f));
      return chrome.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 });
    }, file);
  const ratio = (tab, sel) =>
    tab.evaluate((s) => {
      const lum = (v) => {
        const m = v.match(/[\d.]+/g).map(Number);
        const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
      };
      const el = document.querySelector(s);
      const a = lum(getComputedStyle(el).color);
      const b = lum(getComputedStyle(document.body).backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    }, sel);

  await t.test('low-contrast text is lightened to WCAG AA', async () => {
    await settings({});
    const tab = await open('contrast.html');
    await wait(1500);
    assert.ok((await ratio(tab, '#low')) >= 4.5, `ratio ${await ratio(tab, '#low')}`);
    const r = await report('contrast.html');
    assert.ok(r.contrast.checked >= 2);
    assert.equal(r.contrast.fixed, 1);
    assert.ok(r.cost > 0 && r.cost < 200, `cost ${r.cost}`);
    await tab.close();
  });

  await t.test('the check can be turned off', async () => {
    await settings({ fixContrast: false });
    const tab = await open('contrast.html');
    await wait(1500);
    assert.ok((await ratio(tab, '#low')) < 4.5);
    assert.equal(await tab.evaluate(() => document.querySelectorAll('[data-dusk-contrast]').length), 0);
    await tab.close();
  });

  await t.test('picker: choose an element, invert it, saved for the site', async () => {
    await settings({});
    const tab = await open('picker.html');
    // What the popup does: inject the picker, then start it.
    await worker.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url?.includes('picker.html'));
      await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ['picker.js'] });
      await chrome.tabs.sendMessage(t.id, { type: 'pick' }, { frameId: 0 });
    });
    await wait(200);
    const box = await (await tab.$('#logo')).boundingBox();
    await tab.mouse.move(box.x + 10, box.y + 10);
    await wait(100);
    await tab.mouse.click(box.x + 10, box.y + 10);
    await wait(100);
    await tab.keyboard.press('Enter');
    await wait(400);
    // A stable id wins over classes.
    assert.deepEqual((await sync()).userFixes, { localhost: [['img#logo', 'invert']] });
    assert.match(await css(tab, '#logo', 'filter'), /invert/);
    await tab.close();
  });

  await t.test('remember-sites off: nothing is cached', async () => {
    await settings({ rememberSites: false });
    // Earlier tests' pages may still be finishing a cache write; let them land, then start clean.
    await wait(1500);
    await worker.evaluate(() => chrome.storage.local.clear());
    const tab = await open('basic.html');
    await wait(2500);
    await tab.close();
    const local = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(Object.keys(local).filter((k) => k.startsWith('c:')), []);
  });
});
