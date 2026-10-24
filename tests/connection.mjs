import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('packages/extension/dist/manifest.json', root)));
const packaged = JSON.parse(readFileSync(new URL('packages/skimlet/assets/manifest.json', root)));
assert.equal(manifest.key, packaged.key);
assert.equal(manifest.name, 'Skimlet');
assert.equal(manifest.minimum_chrome_version, '125');
assert.ok(!manifest.host_permissions && !manifest.content_scripts);
assert.deepEqual(manifest.permissions, ['activeTab', 'debugger', 'tabGroups']);
for (const path of [manifest.background.service_worker, manifest.action.default_icon, ...Object.values(manifest.icons)]) {
  assert.ok(readFileSync(new URL(`packages/extension/dist/${path}`, root)).length);
}
const storeIcon = readFileSync(new URL(`packages/extension/dist/${manifest.icons['128']}`, root));
assert.equal(storeIcon.readUInt32BE(16), 128);
assert.equal(storeIcon.readUInt32BE(20), 128);
const code = readFileSync(new URL('packages/extension/dist/background.js', root), 'utf8');
assert.ok(!/Playwriter|playwriter|process\.env/.test(code), 'The browser bundle must use Skimlet branding and no runtime environment');
const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const extensionId = [...hash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const storeOrigin = 'chrome-extension://fiipfignceankihmkhfjldmniofechoh';
console.log('PASS built Skimlet extension assets and branding');

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

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const port = await freePort();
process.env.SKIMLET_PORT = String(port);
const { ensureRelay } = await import('../packages/skimlet/dist/relay-server/client.js');
const ownedPid = await ensureRelay();
assert.ok(ownedPid && ownedPid !== process.pid, 'The relay must run outside the MCP process');
let ws, connection;
try {
  await rejection({}, 403);
  await rejection({ Origin: 'https://example.com' }, 403);
  await rejection({ Origin: 'chrome-extension://jfeammnjpkecdekppnclgkkffahnhfhe' }, 403);
  const unpacked = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { Origin: `chrome-extension://${extensionId}` } });
  await new Promise((resolve, reject) => { unpacked.once('open', resolve); unpacked.once('error', reject); });
  unpacked.close();
  await new Promise(resolve => unpacked.once('close', resolve));
  ws = new WebSocket(`ws://127.0.0.1:${port}/extension?capabilities=inventory-ready-v1&browser=Chrome%20(Skimlet)`, { headers: { Origin: storeOrigin } });
  const commands = [], tabs = new Map(), closedKeys = [];
  let nextTab = 0;
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.method === 'ping') ws.send(JSON.stringify({ method: 'pong' }));
    else if (msg.id !== undefined) {
      commands.push(msg.params?.method || msg.method);
      if (msg.method === 'forwardCDPCommand' && msg.params.method === 'Target.createTarget') {
        const index = ++nextTab, targetId = `target-${index}`, sessionId = `tab-${index}`;
        tabs.set(targetId, { targetId, sessionId, key: msg.params.tabGroupKey });
        ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { method: 'Target.attachedToTarget',
          params: { sessionId, targetInfo: { targetId, type: 'page', url: 'about:blank', title: '', attached: true }, waitingForDebugger: false } } }));
        ws.send(JSON.stringify({ id: msg.id, result: { targetId } }));
      } else if (msg.method === 'closeTabsForKey') {
        closedKeys.push(msg.params.key);
        for (const [id, tab] of tabs) if (tab.key === msg.params.key) tabs.delete(id);
        ws.send(JSON.stringify({ id: msg.id, result: { success: true } }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ method: 'ready' }));
  const { connectViaExtension, createRelaySession, deleteRelaySession } = await import('../packages/skimlet/dist/browser-client/client.js');
  connection = await connectViaExtension({ port });
  assert.equal(connection.browser.contexts().length, 1);
  assert.equal(connection.browser.contexts()[0].pages().length, 0);
  assert.ok(commands.includes('Target.setAutoAttach'));
  const version = await (await fetch(`http://127.0.0.1:${port}/version`)).json();
  const { version: packageVersion } = JSON.parse(readFileSync(new URL('packages/skimlet/package.json', root)));
  assert.deepEqual(version, { version: packageVersion, name: 'skimlet' });
  const badHost = await new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/version', headers: { Host: 'other.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.once('error', reject); request.end();
  });
  assert.equal(badHost, 403);
  console.log('PASS detached relay, Store and unpacked origins, and Playwright handshake');

  const first = await createRelaySession(port, storeOrigin);
  const second = await createRelaySession(port, storeOrigin);
  const rawClients = [];
  async function rawClient(session) {
    const client = new WebSocket(`ws://127.0.0.1:${port}/cdp/test-${session.id}?session=${session.id}&extensionId=${encodeURIComponent(storeOrigin)}`);
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    rawClients.push(client);
    let nextId = 0;
    const pending = new Map(), events = [];
    client.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.id === undefined) events.push(message);
      else {
        const waiter = pending.get(message.id);
        if (waiter) { pending.delete(message.id); waiter(message); }
      }
    });
    return { events, async send(method, params = {}) {
      const id = ++nextId;
      return new Promise(resolve => { pending.set(id, resolve); client.send(JSON.stringify({ id, method, params })); });
    } };
  }
  try {
    const a = await rawClient(first), b = await rawClient(second);
    const invalidDelete = await fetch(`http://127.0.0.1:${port}/cli/session/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: first.id, ownershipKey: 'wrong', closeCreatedTabs: true }),
    });
    assert.equal(invalidDelete.status, 409);
    const createdA = await a.send('Target.createTarget', { url: 'about:blank' });
    assert.ok(!createdA.error, JSON.stringify(createdA));
    assert.equal(a.events.filter(event => event.method === 'Target.attachedToTarget').length, 1);
    assert.equal(b.events.length, 0, 'Other agents must not see created tabs');
    assert.equal((await b.send('Target.getTargets')).result.targetInfos.length, 0);
    assert.match((await b.send('Target.closeTarget', { targetId: createdA.result.targetId })).error.message, /does not belong/);
    const createdB = await b.send('Target.createTarget', { url: 'about:blank' });
    assert.equal((await a.send('Target.getTargets')).result.targetInfos.length, 1);
    await deleteRelaySession(port, first);
    assert.ok(closedKeys.includes(first.ownershipKey));
    assert.equal(tabs.has(createdA.result.targetId), false);
    assert.equal(tabs.has(createdB.result.targetId), true);
    assert.equal((await b.send('Target.getTargets')).result.targetInfos.length, 1);
    console.log('PASS per-agent CDP routing, ownership checks, and tab cleanup');
  } finally {
    await deleteRelaySession(port, first).catch(() => {});
    await deleteRelaySession(port, second).catch(() => {});
    for (const client of rawClients) client.close();
  }
  const clients = [];
  try {
    for (let i = 0; i < 2; i++) {
      const transport = new StdioClientTransport({ command: process.execPath,
        args: ['packages/skimlet/dist/mcp/mcp.js'], cwd: new URL('../', import.meta.url).pathname,
        env: { ...process.env }, stderr: 'pipe' });
      const client = new Client({ name: `agent-${i}`, version: '1' });
      await client.connect(transport);
      clients.push(client);
      assert.equal(client.getServerVersion().version, packageVersion);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['search']);
    }
    await clients[0].close();
    assert.equal(await ensureRelay(), undefined);
    assert.doesNotThrow(() => process.kill(ownedPid, 0));
    assert.deepEqual((await clients[1].listTools()).tools.map(tool => tool.name), ['search']);
    console.log('PASS two MCP agents reuse the relay after one exits');
  } finally { await Promise.all(clients.map(client => client.close())); }
} finally {
  await connection?.close();
  ws?.close();
  process.kill(ownedPid, 'SIGTERM');
}
