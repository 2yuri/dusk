import * as esbuild from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { buildFixes } from './tools/fixes.mjs';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const MODES = ['auto-dynamic', 'auto-filter', 'dynamic', 'filter', 'off'];
/** Bundled so extension pages never fetch fonts from the network. */
const FONTS = [
  ['inter', 'inter'],
  ['inter-tight', 'inter-tight'],
  ['jetbrains-mono', 'jetbrains-mono'],
];

await rm('dist', { recursive: true, force: true });

/** One-line scripts registered in front of content.js to hand it the site's mode synchronously. */
async function writeFlags() {
  await mkdir('dist/flags', { recursive: true });
  for (const mode of MODES) {
    for (const sys of [false, true]) {
      const body = `globalThis.__dusk=${JSON.stringify({ mode, sys })};`;
      await writeFile(`dist/flags/${mode}${sys ? '-sys' : ''}.js`, body);
    }
  }
}

const copyStatic = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async () => {
      await cp('static', 'dist', { recursive: true });
      await mkdir('dist/fonts', { recursive: true });
      for (const [name, pkg] of FONTS) {
        await cp(`node_modules/@fontsource-variable/${pkg}/files/${pkg}-latin-wght-normal.woff2`, `dist/fonts/${name}.woff2`);
      }
      await writeFlags();
      await buildFixes('dist/fixes.json');
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    main: 'src/main-world.ts',
    popup: 'src/popup.ts',
    options: 'src/options.ts',
    picker: 'src/picker.ts',
  },
  loader: { '.svg': 'text' },
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outdir: 'dist',
  minify: !dev,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  plugins: [copyStatic],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
