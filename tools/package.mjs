// Builds a release: node tools/package.mjs -> release/dusk-<version>.zip (load it in Chrome, or upload to the Web Store)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('static/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.version !== version) throw new Error(`package.json ${pkg.version} != manifest ${version}`);

execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
await mkdir('release', { recursive: true });
const zip = `release/dusk-${version}.zip`;
await rm(zip, { force: true });
// -X: no extra file attributes, so the archive only depends on the files.
execFileSync('zip', ['-r', '-X', '-q', `../${zip}`, '.'], { cwd: 'dist' });
const sha = createHash('sha256').update(await readFile(zip)).digest('hex');
await writeFile(`${zip}.sha256`, `${sha}  dusk-${version}.zip\n`);
console.log(`${zip}\nsha256 ${sha}`);
