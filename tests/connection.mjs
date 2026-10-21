import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import net from 'node:net';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('packages/extension/dist/manifest.json', root)));
const packaged = JSON.parse(readFileSync(new URL('packages/mcp/assets/manifest.json', root)));
assert.equal(manifest.key, packaged.key);
assert.equal(manifest.name, 'Skimlet');
assert.equal(manifest.minimum_chrome_version, '125');
assert.ok(!manifest.host_permissions && !manifest.content_scripts);
assert.deepEqual(manifest.permissions, ['activeTab', 'debugger', 'tabGroups']);
for (const path of [manifest.background.service_worker, manifest.action.default_icon, ...Object.values(manifest.icons)]) {
  assert.ok(readFileSync(new URL(`packages/extension/dist/${path}`, root)).length);
}
const code = readFileSync(new URL('packages/extension/dist/background.js', root), 'utf8');
assert.ok(!/Playwriter|playwriter|process\.env/.test(code), 'The browser bundle must use Skimlet branding and no runtime environment');
const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const extensionId = [...hash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const origin = `chrome-extension://${extensionId}`;
console.log('PASS built Skimlet extension, matching MCP identity and branding');

function rejection(headers, expected) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers });
    ws.once('open', () => { ws.close(); reject(new Error('Unexpected connection')); });
    ws.once('error', reject);
    ws.once('unexpected-response', (_, response) => {
      response.resume();
      try { assert.equal(response.statusCode, expected); resolve(); } catch (error) { reject(error); }
    });
  });
}

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
process.env.SKIMLET_PORT = String(port);
const { startRelay, stopRelay } = await import('../packages/mcp/dist/mcp.js');
await startRelay();
let ws, connection;
try {
  await rejection({}, 403);
  await rejection({ Origin: 'https://example.com' }, 403);
  await rejection({ Origin: 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' }, 403);
  ws = new WebSocket(`ws://127.0.0.1:${port}/extension?capabilities=inventory-ready-v1&browser=Chrome%20(Skimlet)`, { headers: { Origin: origin } });
  const commands = [];
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.method === 'ping') ws.send(JSON.stringify({ method: 'pong' }));
    else if (msg.id !== undefined) {
      commands.push(msg.params?.method || msg.method);
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ method: 'ready' }));
  const { connectViaExtension } = await import('playwriter');
  connection = await connectViaExtension({ port, tabGroup: 'Skimlet', logger: { log() {} } });
  assert.equal(connection.browser.contexts().length, 1);
  assert.equal(connection.browser.contexts()[0].pages().length, 0);
  assert.ok(commands.includes('Target.setAutoAttach'));
  console.log('PASS stock relay, Skimlet origin and real SDK handshake');
} finally {
  await connection?.close();
  ws?.close();
  await stopRelay();
}
