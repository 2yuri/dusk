import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_THEME, luminance, modify, parseColor, type Theme } from '../src/color.ts';
import { inTimeRange, siteMode, DEFAULTS } from '../src/settings.ts';
import { Ctx, roleOf, shorthandsOf } from '../src/transform.ts';

const theme: Theme = DEFAULT_THEME;
const ctx = (vars: string[] = []) => new Ctx(theme, new Set(vars));
const lum = (v: string) => luminance(parseColor(v)!);

test('parses the common color syntaxes', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#00000080'), { r: 0, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColor('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
  assert.deepEqual(parseColor('rgba(10,20,30,.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('White'), { r: 255, g: 255, b: 255, a: 1 });
  const red = parseColor('hsl(0 100% 50%)')!;
  assert.equal(Math.round(red.r), 255);
  assert.equal(Math.round(red.g), 0);
});

test('white and black land exactly on the chosen palette', () => {
  const custom = { ...theme, bgColor: '#202830', fgColor: '#f0e0d0' };
  const c = new Ctx(custom, new Set());
  assert.equal(c.transform('#fff', 'bg'), '#202830');
  assert.equal(c.transform('#000', 'fg'), '#f0e0d0');
});

test('backgrounds go dark, text goes light, dark stays dark', () => {
  assert.ok(luminance(modify(parseColor('#fff')!, 'bg', theme)) < 0.03);
  assert.ok(luminance(modify(parseColor('#000')!, 'fg', theme)) > 0.6);
  assert.ok(luminance(modify(parseColor('#111')!, 'bg', theme)) < 0.03);
  assert.ok(luminance(modify(parseColor('#eee')!, 'fg', theme)) > 0.6);
  const blueLink = modify(parseColor('#0000ee')!, 'fg', theme);
  assert.ok(luminance(blueLink) > 0.2, 'links stay readable on dark backgrounds');
});

test('rewrites colors inside complex values and leaves the rest alone', () => {
  const c = ctx();
  assert.equal(c.transform('1px solid', 'bd'), null);
  assert.equal(c.transform('inherit', 'fg'), null);
  assert.match(c.transform('linear-gradient(#fff, white 50%)', 'bg')!, /^linear-gradient\(#[0-9a-f]{6}, #[0-9a-f]{6} 50%\)$/);
  assert.match(c.transform('0 1px 2px rgba(0,0,0,.2)', 'bg')!, /^0 1px 2px rgba\(0,0,0,0\.2\)$/);
  // Color words inside urls, strings and identifiers are not colors.
  assert.equal(c.transform('url(white.png)', 'bg'), null);
  assert.equal(c.transform('var(--white)', 'bg'), null);
});

test("Tailwind's var() alpha survives", () => {
  const out = ctx().transform('rgb(255 255 255 / var(--tw-bg-opacity))', 'bg')!;
  assert.match(out, /^rgb\(\d+ \d+ \d+ \/ var\(--tw-bg-opacity\)\)$/);
  assert.ok(lum(out.replace(/\/.*\)/, ')')) < 0.05);
});

test('color variables are redirected per role, fallbacks transformed too', () => {
  const c = ctx(['--bg']);
  assert.equal(c.transform('var(--bg)', 'bg'), 'var(--dusk-bg--bg)');
  assert.equal(c.transform('var(--bg)', 'fg'), 'var(--dusk-fg--bg)');
  assert.match(c.transform('var(--other, #fff)', 'bg')!, /^var\(--other, #[0-9a-f]{6}\)$/);
  assert.ok(c.isColorish('#fff'));
  assert.ok(c.isColorish('var(--bg)'));
  assert.ok(!c.isColorish('12px'));
  assert.ok(!c.isColorish('var(--size)'));
});

test('url() in emitted values is made absolute against the sheet', () => {
  const c = ctx();
  c.base = 'https://cdn.example.com/css/site.css';
  assert.equal(c.transform('url(../img/a.png) #fff', 'bg'), 'url("https://cdn.example.com/img/a.png") #181a1b');
});

test('property roles and shorthand lookup', () => {
  assert.equal(roleOf('background-color'), 'bg');
  assert.equal(roleOf('color'), 'fg');
  assert.equal(roleOf('border-top-color'), 'bd');
  assert.equal(roleOf('border-block-start'), 'bd');
  assert.equal(roleOf('border-top-width'), null);
  assert.equal(roleOf('width'), null);
  assert.deepEqual(shorthandsOf('border-top-color'), ['border-top', 'border-color', 'border']);
});

test('site modes and schedules', () => {
  const s = { ...DEFAULTS, siteModes: { 'a.com': 'off' as const, 'b.com': 'filter' as const } };
  assert.equal(siteMode(s, 'x.com'), 'auto-dynamic');
  assert.equal(siteMode(s, 'a.com'), 'off');
  assert.equal(siteMode(s, 'b.com'), 'filter');
  assert.equal(siteMode({ ...s, enabled: false }, 'b.com'), 'off');
  assert.equal(siteMode({ ...s, onlyListed: true }, 'x.com'), 'off');
  assert.equal(siteMode({ ...s, onlyListed: true }, 'b.com'), 'filter');
  const night = { ...DEFAULTS, timeFrom: '19:00', timeTo: '07:00' };
  assert.ok(inTimeRange(night, new Date(2026, 0, 1, 23, 0)));
  assert.ok(inTimeRange(night, new Date(2026, 0, 1, 3, 0)));
  assert.ok(!inTimeRange(night, new Date(2026, 0, 1, 12, 0)));
});

test('Dark Reader URL patterns', async () => {
  const { compilePattern } = await import('../src/fixes.ts');
  const m = (p: string, target: string) => compilePattern(p).test(target);
  assert.ok(m('wikipedia.org', 'wikipedia.org/wiki/X'));
  assert.ok(m('wikipedia.org', 'www.wikipedia.org/'));
  assert.ok(!m('wikipedia.org', 'en.wikipedia.org/wiki/X'));
  assert.ok(m('*.wikipedia.org', 'en.wikipedia.org/wiki/X'));
  assert.ok(!m('wikipedia.org', 'wikipedia.org.evil.com/'));
  assert.ok(m('google.*', 'google.com.br/search'));
  assert.ok(m('example.com/docs', 'example.com/docs/a'));
  assert.ok(!m('example.com/docs', 'example.com/blog'));
  assert.ok(m('*', 'anything.com/'));
});

test('SVG icons: dark or unpainted ones are recolored, colorful ones kept', async () => {
  const { analyze } = await import('../src/images.ts');
  const svg = (body: string) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);
  assert.match((await analyze(svg('<path d="M0 0h1v1z"/>')))!, /^data:image\/svg\+xml;base64,/);
  assert.ok(await analyze(svg('<path fill="#111" d="M0 0h1v1z"/>')));
  assert.ok(await analyze(svg('<path fill="currentColor" d="M0 0h1v1z"/>')));
  assert.equal(await analyze(svg('<path fill="#f5a623" d="M0 0h1v1z"/>')), null);
  assert.equal(await analyze(svg('<path fill="#fff" d="M0 0h1v1z"/>')), null);
  assert.equal(await analyze('javascript:alert(1)'), null);
});

test('selector specificity orders the cascade', async () => {
  const { specificity } = await import('../src/detect.ts');
  assert.ok(specificity('html[data-theme="dark"]') > specificity('html'));
  assert.ok(specificity('#a') > specificity('.a.b.c'));
  assert.ok(specificity('.a') > specificity('div span'));
  assert.equal(specificity(':where(.x) html'), specificity('html'));
});
