// Bundle the Skimlet-owned TypeScript extension. No upstream source rewriting.
import { build } from 'esbuild';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'packages/extension/src');
const output = join(root, 'packages/extension/dist');
const pkg = JSON.parse(await readFile(join(root, 'node_modules/playwriter/package.json'), 'utf8'));
if (pkg.version !== '0.8.0') throw new Error('Review extension protocol before changing Playwriter 0.8.0');
await mkdir(join(output, 'icons'), { recursive: true });
await build({ entryPoints: [join(source, 'background.ts')], outfile: join(output, 'background.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome125',
  define: { SKIMLET_PROTOCOL_VERSION: JSON.stringify(pkg.version) },
});
await Promise.all(['on.png', 'off.png'].map(name => copyFile(join(source, 'assets/icons', name), join(output, 'icons', name))));
await copyFile(join(source, 'assets/manifest.json'), join(output, 'manifest.json'));
await mkdir(join(root, 'packages/mcp/assets'), { recursive: true });
await copyFile(join(source, 'assets/manifest.json'), join(root, 'packages/mcp/assets/manifest.json'));
console.error(`Built Skimlet Chrome extension at ${output}`);
