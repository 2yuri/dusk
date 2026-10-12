// Design (left) vs implementation (right), one image per view: node bench/compare.mjs
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const PAIRS = [
  ['popup-active', 'p11iK'], ['popup-already-dark', 'YetcZ'], ['popup-off', 'X60jy'],
  ['popup-unsupported', '7tlwn'], ['popup-opted-out', '1Sboy'],
  ['options', 'UZ6Az'], ['options-adding', 'uT6p5'], ['options-empty', '85eCk'], ['options-fixes-empty', 'udlYs'],
  ['picker-choosing', 'auCZm'], ['picker-menu', 'eqjCo'], ['picker-applied', 'DLJZK'],
];
const b64 = async (p) => (await readFile(p)).toString('base64');
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const [impl, design] of PAIRS) {
  const wide = impl.startsWith('options') || impl.startsWith('picker');
  await page.setViewport({ width: wide ? 2600 : 1000, height: 400 });
  await page.setContent(`<style>body{margin:0;display:flex;gap:24px;padding:16px;background:#333;font:14px system-ui;color:#fff;align-items:flex-start}
    figure{margin:0;flex:1}img{width:100%;display:block}</style>
    <figure><figcaption>design</figcaption><img src="data:image/png;base64,${await b64(`design/export/views/${design}.png`)}"></figure>
    <figure><figcaption>implementation</figcaption><img src="data:image/png;base64,${await b64(`bench/out/ui/${impl}.png`)}"></figure>`);
  await page.screenshot({ path: `bench/out/ui/compare-${impl}.png`, fullPage: true });
}
await browser.close();
