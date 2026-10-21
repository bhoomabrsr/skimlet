// Chrome Web Store forbids the development-only manifest key. Keep the local
// build unchanged; strip the key only from this upload archive.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
const { key: _developmentKey, ...storeManifest } = manifest;
const output = resolve(process.argv[2] ?? join(root, `skimlet-chrome-store-${manifest.version}.zip`));
const files = ['background.js', 'icons/off.png', 'icons/on.png', 'icons/store-128.png'];
const temp = await mkdtemp(join(tmpdir(), 'skimlet-store-'));

try {
  await mkdir(join(temp, 'icons'));
  await Promise.all(files.map(file => copyFile(join(dist, file), join(temp, file))));
  await writeFile(join(temp, 'manifest.json'), `${JSON.stringify(storeManifest, null, 2)}\n`);
  execFileSync('zip', ['-q', '-X', 'extension.zip', 'manifest.json', ...files], { cwd: temp });
  await mkdir(dirname(output), { recursive: true });
  await copyFile(join(temp, 'extension.zip'), output);
  console.log(`Chrome Web Store ZIP (without manifest key): ${output}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
