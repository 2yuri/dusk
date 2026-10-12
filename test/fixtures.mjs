// Test pages. `CROSS` is replaced with the origin of a second server so
// stylesheets on it are cross-origin to the page.
import { deflateSync } from 'node:zlib';

/** Minimal RGBA PNG encoder for test images. */
function png(w, h, pixel) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const page = (body, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

const manyDarkRules = Array.from({ length: 12 }, (_, i) => `.n${i}{color:#fafafa}`).join('');

export const pages = {
  'basic.html': page(
    '<div class="card" id="card"><p id="p">Hello</p><a id="a" href="#">link</a></div>',
    '<style>body{background:#fff;color:#222}.card{background:#f5f5f5;border:1px solid #ddd}a{color:#0645ad}</style>',
  ),
  'vars.html': page(
    '<div id="box">box</div>',
    '<style>:root{--bg:#ffffff;--text:#111;--alias:var(--bg)}body{background:var(--bg);color:var(--text)}#box{background-color:var(--alias);border:1px solid var(--text)}</style>',
  ),
  'inline.html': page(
    '<div id="d" style="background-color: #fff; color: #000">inline</div>' +
      '<svg width="10" height="10"><path id="path" fill="#000" d="M0 0h10v10z"/></svg>' +
      '<table><tr><td id="td" bgcolor="#ffffff">cell</td></tr></table>',
  ),
  'cross.html': page('<p id="x">cross-origin</p>', '<link rel="stylesheet" href="CROSS/cross.css">'),
  'cross.css': 'body{background:#fff}#x{color:#000;background:#fafafa}',
  'cssinjs.html': page(
    '<div class="late" id="late">late</div>',
    `<script>
      addEventListener('load', () => {
        const s = document.createElement('style');
        document.head.append(s);
        s.sheet.insertRule('.late{background:#fff;color:#000}');
      });
    </script>`,
  ),
  'shadow.html': page(
    `<x-card id="host"></x-card>
     <div id="dsd"><template shadowrootmode="open"><style>.d{background:#fff}</style><div class="d">declarative</div></template></div>
     <script>
       customElements.define('x-card', class extends HTMLElement {
         constructor() {
           super();
           const root = this.attachShadow({ mode: 'open' });
           root.innerHTML = '<style>.in{background:#fff;color:#000}</style><div class="in">in</div><div class="adopted">adopted</div>';
           const sheet = new CSSStyleSheet();
           sheet.replaceSync('.adopted{background:#ffffff}');
           root.adoptedStyleSheets = [sheet];
         }
       });
     </script>`,
    '<style>body{background:#fff}</style>',
  ),
  'dark.html': page('<p>dark</p>', '<style>body{background:#121212;color:#eee}</style>'),
  'native.html': page(
    '<p class="n0">native</p>',
    `<style>body{background:#fff;color:#000}@media (prefers-color-scheme: dark){body{background:#123456;color:#fafafa}${manyDarkRules}}</style>`,
  ),
  'lock.html': page('<p>locked</p>', '<meta name="darkreader-lock"><style>body{background:#fff}</style>'),
  'tailwind.html': page(
    '<div class="bg-white" id="tw">tw</div>',
    '<style>.bg-white{--tw-bg-opacity:1;background-color:rgb(255 255 255 / var(--tw-bg-opacity))}</style>',
  ),
  'misc.html': page(
    '<div id="g">gradient</div><div id="m">media</div><div id="l">layer</div><div id="sh">shorthand</div>',
    `<style>
      #g{background-image:linear-gradient(#fff,#eee)}
      @media (min-width:1px){#m{background:#fff}}
      @layer base{#l{background-color:#fff}}
      :root{--line:#ccc}
      #sh{border:2px solid var(--line)}
    </style>`,
  ),
  // Dark rules exist but only for a class the page doesn't have (like Wikipedia's
  // skin-theme-clientpref-os), so the native theme is rejected and we rewrite.
  'native-rejected.html': page(
    '<div id="ib" style="background-color:#e0e0e0; color:inherit;">infobox</div>',
    `<style>body{background:#fff;color:#000}@media (prefers-color-scheme: dark){html.os-theme body{background:#000}${manyDarkRules.replaceAll('.n', 'html.os-theme .n')}}</style>`,
  ),
  'dark-var.html': page('<p>dark via variables</p>', '<style>:root{--surface:#0d1117}body{background:var(--surface);color:#e6edf3}</style>'),
  'dark-class.html': page(
    '<p>dark via class</p>',
    '<style>body{background:#fff}html[data-theme=dark] body{background:#111}</style><script>document.documentElement.dataset.theme="dark"</script>',
  ),
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M2 2h12v12H2z"/></svg>',
  // A dark glyph on transparency, and an opaque light "photo".
  'icon.png': png(16, 16, (x, y) => (x > 3 && x < 12 && y > 3 && y < 12 ? [10, 10, 10, 255] : [0, 0, 0, 0])),
  'photo.png': png(16, 16, (x, y) => [200 + x, 180 + y, 160, 255]),
  'images.html': page(
    '<span id="svg" class="i"></span><span id="png" class="i"></span><span id="photo" class="i"></span>',
    `<style>.i{display:inline-block;width:16px;height:16px}
      #svg{background-image:url(icon.svg)}#png{background:url(icon.png) no-repeat}#photo{background-image:url(photo.png)}</style>`,
  ),
  // Dark themes behind the site's own toggle.
  'toggle-class.html': page(
    '<div class="card" id="card">card</div>',
    `<style>body{background:#fff;color:#111}.card{background:#f4f4f5}
      .dark body{background:#0b0b0f;color:#ededed}.dark .card{background:#1c1c22}
      ${Array.from({ length: 12 }, (_, i) => `.dark .t${i}{color:#ddd}`).join('')}</style>`,
  ),
  'toggle-attr.html': page(
    '<p>attr theme</p>',
    `<style>:root{--bg:#ffffff;--fg:#111111}[data-theme=dark]{--bg:#101014;--fg:#eeeeee}body{background:var(--bg);color:var(--fg)}
      ${Array.from({ length: 12 }, (_, i) => `[data-theme=dark] .t${i}{color:#ddd}`).join('')}</style>
      <script>document.documentElement.dataset.theme='light'</script>`,
  ),
  // ".dark" here is a button variant, not a theme: setting it on <html> changes nothing.
  'toggle-false.html': page(
    '<p>component variants</p>',
    `<style>body{background:#fff;color:#111}${Array.from({ length: 12 }, (_, i) => `.btn${i}.dark{background:#000;color:#fff}`).join('')}</style>`,
  ),
  // A framework that resets <html class> while hydrating.
  'toggle-hydrate.html': page(
    '<p>hydrating</p>',
    `<style>body{background:#fff}.dark body{background:#0b0b0f}${Array.from({ length: 12 }, (_, i) => `.dark .t${i}{color:#ddd}`).join('')}</style>
      <script>addEventListener('load', () => setTimeout(() => { document.documentElement.className = 'hydrated' }, 100))</script>`,
  ),
  // Text whose color comes through channel variables Dusk can't rewrite: dark on dark until the check fixes it.
  'contrast.html': page(
    '<p id="low" class="t">hard to read</p><p id="ok">fine</p>',
    '<style>body{background:#fff;color:#111}.t{--rgb:40 40 44;color:rgb(var(--rgb))}</style>',
  ),
  'picker.html': page(
    '<header><img class="site-logo" id="logo" width="80" height="20" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></header><p>text</p>',
    '<style>body{background:#fff;margin:40px}</style>',
  ),
  // Outlook's pattern: theme variables set inline on an element by script, used by stylesheet rules.
  'inline-vars.html': `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0}.app{background-color:var(--neutralSecondarySurface);color:var(--neutralPrimary)}
      .row{background-color:var(--neutralLighter)}.late{background:var(--lateSurface,#fff)}</style></head>
      <body><div class="app" id="app" style="--neutralSecondarySurface: #f5f5f5; --neutralPrimary: #242424; --neutralLighter: #f5f5f5;">
      <div class="row" id="row">row</div><div class="late" id="late">late</div></div>
      <script>addEventListener('load', () => setTimeout(() => document.getElementById('app').style.setProperty('--lateSurface', '#fafafa'), 50))</script></body></html>`,
  'dynamic.html': page(
    '<div id="root"></div>',
    `<style>body{background:#fff}</style><script>
      addEventListener('load', () => setTimeout(() => {
        document.getElementById('root').innerHTML = '<div id="added" style="background: white">added</div>';
      }, 50));
    </script>`,
  ),
};
