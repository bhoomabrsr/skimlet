import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'skimlet-packed-'));
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--workspace', '@bhoomabrsr/skimlet', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  assert.equal(packed.name, '@bhoomabrsr/skimlet');
  assert.ok(packed.files.some(file => file.path === 'README.md'));
  assert.ok(packed.files.some(file => file.path === 'LICENSE'));
  assert.ok(!packed.files.some(file => file.path.includes('skimlet-relay') || file.path.includes('UPSTREAM')));
  assert.ok(packed.files.some(file => file.path === 'assets/manifest.json'));
  execFileSync('npm', ['install', '--prefix', temp, '--no-audit', '--no-fund', join(temp, packed.filename)], { stdio: 'pipe' });
  const pkg = join(temp, 'node_modules/@bhoomabrsr/skimlet');
  const manifest = JSON.parse(await readFile(join(pkg, 'assets/manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'Skimlet');
  assert.deepEqual(manifest.permissions, ['activeTab', 'debugger', 'tabGroups']);
  assert.ok((await stat(join(pkg, 'dist/mcp.js'))).mode & 0o111);
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(pkg, 'dist/mcp.js')], cwd: temp, env: { ...process.env, SKIMLET_PORT: String(port) }, stderr: 'pipe' });
  const client = new Client({ name: 'packed-test', version: '1' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['search']);
  } catch (error) { throw new Error(`Packed CLI failed: ${stderr}`, { cause: error }); }
  finally { await client.close(); }
  console.log('PASS tarball installed in temporary directory; plain Node CLI and extension identity');
} finally { await rm(temp, { recursive: true, force: true }); }
