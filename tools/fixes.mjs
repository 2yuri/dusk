// Converts Dark Reader's site-fix configs (MIT, vendored in vendor/darkreader-config)
// into one compact JSON the background worker loads once.
//   node tools/fixes.mjs            -> writes dist/fixes.json (called by build.mjs)
//   node tools/fixes.mjs --update   -> re-downloads the configs at the pinned tag first
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DIR = 'vendor/darkreader-config';
const TAG = 'v4.9.133';
const FILES = ['src/config/dynamic-theme-fixes.config', 'src/config/inversion-fixes.config', 'src/config/dark-sites.config', 'LICENSE'];

function parseSections(text, commands) {
  const out = [];
  for (const section of text.split(/^=+$/m)) {
    const lines = section.replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    const urls = [];
    for (; i < lines.length && lines[i].trim(); i++) urls.push(lines[i].trim());
    if (!urls.length) continue;
    const fix = {};
    let cmd = null;
    for (; i < lines.length; i++) {
      const t = lines[i].trim();
      if (commands.includes(t)) {
        cmd = t;
        fix[cmd] ??= [];
      } else if (cmd) {
        fix[cmd].push(lines[i]);
      }
    }
    const list = (k) => (fix[k] ?? []).map((l) => l.trim()).filter(Boolean);
    const css = (fix.CSS ?? []).join('\n').trim();
    out.push({ urls, list, css });
  }
  return out;
}

export async function buildFixes(outFile) {
  const dyn = parseSections(await readFile(`${DIR}/dynamic-theme-fixes.config`, 'utf8'), [
    'INVERT',
    'CSS',
    'IGNORE INLINE STYLE',
    'IGNORE IMAGE ANALYSIS',
    'IGNORE CSS URL',
  ]).map((s) => [s.urls, s.list('INVERT'), s.css, s.list('IGNORE INLINE STYLE')]);
  const inv = parseSections(await readFile(`${DIR}/inversion-fixes.config`, 'utf8'), [
    'INVERT',
    'NO INVERT',
    'REMOVE BG',
    'CSS',
  ]).map((s) => [s.urls, s.list('INVERT'), s.list('NO INVERT'), s.list('REMOVE BG'), s.css]);
  const dark = (await readFile(`${DIR}/dark-sites.config`, 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  await writeFile(outFile, JSON.stringify({ dyn, inv, dark }));
}

if (process.argv[1]?.endsWith('fixes.mjs')) {
  if (process.argv.includes('--update')) {
    await mkdir(DIR, { recursive: true });
    for (const f of FILES) {
      const res = await fetch(`https://raw.githubusercontent.com/darkreader/darkreader/${TAG}/${f}`);
      if (!res.ok) throw new Error(`${f}: ${res.status}`);
      await writeFile(`${DIR}/${f.split('/').pop()}`, await res.text());
    }
  }
  await mkdir('dist', { recursive: true });
  await buildFixes('dist/fixes.json');
  console.log('fixes written');
}
