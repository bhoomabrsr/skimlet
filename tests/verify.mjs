import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Extension, createApp, extract, failure } from '../packages/skimlet/dist/mcp/mcp.js';
import { skimletVersion } from '../packages/skimlet/dist/relay-server/client.js';
import { parseGoogle, searchUrl as googleSearchUrl } from '../packages/skimlet/dist/adapters/google.js';
const appRoot = new URL('../', import.meta.url).pathname;
const require = createRequire(new URL('../packages/skimlet/package.json', import.meta.url));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const serp = (links, extra = '') => `<html><body><div id="rso">${links.map((url, i) => `<div class="tF2Cxc"><a href="${url.replaceAll('&', '&amp;')}"><h3>Title ${i}</h3></a><div class="VwiC3b">Snippet ${i}</div></div>`).join('')}</div>${extra}</body></html>`;
const searchUrl = googleSearchUrl('test');
const article = '<html><head><title>Fixture article</title></head><body><article><h1>Fixture heading</h1><p>' + ('This is a readable paragraph about browser automation and local extraction. '.repeat(12)) + '</p><h2>Steps</h2><ul><li>First step</li><li>Second step</li></ul><p><a href="/guide">Read the guide</a></p></article></body></html>';

test('Google: ads, duplicates, opaque links, local unwrap, distinct ports', () => {
  const html = serp(['https://example.com:8000/a?source=x', 'https://example.com:9000/a?source=x', '/url?q=https%3A%2F%2Fexample.org%2Fx%3Fa%3D1%26a%3D2', '/url?token=opaque', 'https://example.com:8000/a?source=x'])
    .replace('</div></body>', '<div data-text-ad><a href="https://ad.example/"><h3>Ad</h3></a></div></div></body>');
  const parsed = parseGoogle(html, searchUrl);
  assert.equal(parsed.results.length, 4);
  assert.equal(parsed.results[2].url, 'https://example.org/x?a=1&a=2');
  assert.equal(parsed.results[2].linkStatus, 'unwrapped');
  assert.equal(parsed.results[3].linkStatus, 'unresolved');
  assert.deepEqual(parsed.results.map(x => x.rank), [1, 2, 3, 4]);
});
test('Google: empty wins over incidental JavaScript warning; failures stay explicit', () => {
  assert.deepEqual(parseGoogle('<div id="topstuff">No results found</div><p>Enable JavaScript</p>', searchUrl).results, []);
  assert.throws(() => parseGoogle('<p>Enable JavaScript to continue</p>', searchUrl), /javascript_required/);
  assert.throws(() => parseGoogle('<p>Changed layout</p>', searchUrl), /layout_changed/);
  assert.throws(() => parseGoogle('<p>Consent</p>', 'https://consent.google.com/m'), /consent_required/);
  assert.throws(() => parseGoogle('<form id="captcha-form"></form>', searchUrl), /challenge_detected/);
  assert.throws(() => parseGoogle(serp(['https://example.com']), 'https://google.evil.com/search'), /unexpected_search_page/);
});
test('Google: validate next URL; malformed next does not lose listings', () => {
  const valid = parseGoogle(serp(['https://example.com'], '<a id="pnnext" href="/search?q=test&start=10">Next</a>'), searchUrl);
  assert.equal(new URL(valid.next).searchParams.get('start'), '10');
  assert.equal(parseGoogle(serp(['https://example.com'], '<a id="pnnext" href="javascript:alert(1)">Next</a>'), searchUrl).results.length, 1);
});
test('Extraction: Markdown structure, absolute links, Unicode cap, no iframe text', () => {
  const result = extract(article, 'https://example.com/a', 'markdown', 20_000);
  assert.match(result.content, /## Steps/);
  assert.match(result.content, /First step/);
  assert.match(result.content, /https:\/\/example.com\/guide/);
  assert.equal(result.truncated, false);
  const short = extract('<body><p>😀😀😀😀</p><iframe>not included</iframe></body>', 'https://example.com', 'text', 3);
  assert.equal(short.content, '😀😀😀'); assert.equal(short.truncated, true);
});

function fakeConnector({ closeFails = false } = {}) {
  const browser = new EventEmitter();
  let connected = true, open = 0, creates = 0, highWater = 0, cleaned = 0;
  browser.isConnected = () => connected;
  browser.contexts = () => [{ async newPage() {
    creates++; open++; highWater = Math.max(highWater, open);
    await delay(3);
    const page = new EventEmitter(); let closed = false;
    page.isClosed = () => closed;
    page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
    page.close = async () => {
      if (closeFails) throw new Error('close failed');
      if (closed) return;
      await delay(3); closed = true; open--; page.emit('close');
    };
    return page;
  }}];
  const connector = async () => ({ browser, sessionId: 'ours', async close() { cleaned++; connected = false; browser.emit('disconnected'); }, extensionBrowser: {} });
  return { connector, stats: () => ({ open, creates, highWater, cleaned }) };
}
for (const limit of [5, 10]) test(`Tab adapter: 100 tasks at limit ${limit}; closure counts; session cleanup once`, async () => {
  const fake = fakeConnector(), adapter = new Extension(limit, fake.connector);
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => adapter.page(new AbortController().signal, async () => { await delay(5); return i; })));
  assert.equal(results.length, 100);
  assert.equal(fake.stats().highWater, limit);
  assert.equal(fake.stats().open, 0);
  await Promise.all([adapter.close(), adapter.close()]);
  assert.equal(fake.stats().cleaned, 1);
});
test('Tab adapter: cancellation during creation closes late tab; queued work creates none', async () => {
  const fake = fakeConnector(), adapter = new Extension(1, fake.connector), abort = new AbortController();
  const jobs = Array.from({ length: 10 }, () => adapter.page(abort.signal, async () => assert.fail('aborted callback ran')));
  await delay(1); abort.abort();
  assert.ok((await Promise.allSettled(jobs)).every(x => x.status === 'rejected'));
  assert.equal(fake.stats().creates, 1); assert.equal(fake.stats().open, 0);
  await adapter.close();
});
test('Tab adapter: failed closure stops new admission', async () => {
  const fake = fakeConnector({ closeFails: true }), adapter = new Extension(1, fake.connector);
  await assert.rejects(adapter.page(new AbortController().signal, async () => 'ok'), /tab_cleanup_failed/);
  await assert.rejects(adapter.page(new AbortController().signal, async () => 'wrong'), /stopped/);
  assert.equal(fake.stats().creates, 1); await adapter.close();
});
test('Tab adapter: cancelling active navigation closes only its worker and frees capacity', async () => {
  const fake = fakeConnector(), adapter = new Extension(1, fake.connector), abort = new AbortController();
  let started; const ready = new Promise(resolve => { started = resolve; });
  const pending = adapter.page(abort.signal, page => new Promise((resolve, reject) => {
    page.once('close', () => reject(new Error('navigation closed'))); started();
  }));
  await ready; abort.abort(); await assert.rejects(pending, /navigation closed/);
  assert.equal(fake.stats().open, 0);
  assert.equal(await adapter.page(new AbortController().signal, async () => 'next'), 'next');
  await adapter.close();
});

function fixtureExtension() {
  const visits = []; let connected = false;
  return { visits, async ready() { connected = true; }, async close() {}, async page(signal, read) {
    signal.throwIfAborted(); let url;
    const page = { async goto(value) { url = value; visits.push(value); await delay(5); return { status: () => value.includes('broken.example') ? 500 : 200 }; },
      locator() { return { first() { return this; }, async waitFor() {} }; },
      url: () => url, isClosed: () => false,
      async content() { return url.includes('google.com/search') ? serp(['https://example.com/article', 'https://broken.example/article']) : article; } };
    return read(page);
  }};
}
async function mcp(extension, run) {
  const app = createApp(extension), client = new Client({ name: 'verification', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await app.server.connect(a); await client.connect(b);
  try { await run(client); } finally { await client.close(); await app.close(); }
}
test('MCP: disconnected browser points to Skimlet', async () => {
  assert.equal(failure(new Error('port busy')), 'port busy');
  const extension = { async ready() { throw new Error('Skimlet Chrome extension is not connected. Click its icon to attach.'); }, async close() {} };
  await mcp(extension, async client => {
    const reply = await client.callTool({ name: 'search', arguments: { queries: ['test'], includeContent: false } });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /Skimlet Chrome extension is not connected/);
    assert.doesNotMatch(reply.content[0].text, /Playwriter extension/);
  });
});
test('MCP: discovery, search-only, cross-query content dedupe and partial failures', async () => {
  const extension = fixtureExtension();
  await mcp(extension, async client => {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['search']);
    const only = JSON.parse((await client.callTool({ name: 'search', arguments: { queries: ['one'], includeContent: false } })).content[0].text);
    assert.equal(only.queries[0].results[0].contentStatus, 'not_requested');
    assert.equal(extension.visits.length, 1);
    extension.visits.length = 0;
    const full = JSON.parse((await client.callTool({ name: 'search', arguments: { queries: ['one', 'two'] } })).content[0].text);
    assert.equal(full.queries.length, 2);
    assert.equal(full.queries[0].results[0].contentStatus, 'success');
    assert.equal(full.queries[0].results[1].contentStatus, 'failed');
    assert.equal(extension.visits.filter(x => x === 'https://example.com/article').length, 1);
    assert.equal(extension.visits.filter(x => x === 'https://broken.example/article').length, 1);
  });
});
test('MCP: unknown engines/keys rejected; overlapping batch is busy', async () => {
  const extension = fixtureExtension();
  await mcp(extension, async client => {
    for (const args of [{ queries: ['one'], engine: 'bing' }, { queries: ['one'], unknown: true }]) {
      const result = await client.callTool({ name: 'search', arguments: args });
      assert.equal(result.isError, true);
    }
    assert.equal(extension.visits.length, 0);
    const first = client.callTool({ name: 'search', arguments: { queries: ['one'] } });
    await delay(1);
    const second = await client.callTool({ name: 'search', arguments: { queries: ['two'] } });
    assert.equal(second.isError, true); assert.match(second.content[0].text, /busy/); await first;
  });
});
test('MCP: real stdio handshake and tool discovery', async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const relay = spawn(process.execPath, ['packages/skimlet/dist/relay-server/server.js'],
    { cwd: appRoot, env: { ...process.env, SKIMLET_PORT: String(port) }, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      await delay(100);
      ready = await fetch(`http://127.0.0.1:${port}/version`).then(response => response.ok).catch(() => false);
    }
    assert.ok(ready, 'Detached relay did not start');
    const transport = new StdioClientTransport({ command: process.execPath, args: ['packages/skimlet/dist/mcp/mcp.js'], cwd: appRoot,
      env: { ...process.env, SKIMLET_PORT: String(port) }, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'stdio-test', version: '1' });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools[0].name, 'search');
      await client.close();
      assert.equal((await (await fetch(`http://127.0.0.1:${port}/version`)).json()).version, skimletVersion);
      assert.doesNotMatch(stderr, /Error:/);
    } finally { await client.close().catch(() => {}); }
  } finally { relay.kill('SIGTERM'); }
});
test('Real local Chromium: rendered HTML, context cookies, human tab untouched, navigation cancellation', async () => {
  const { chromium } = require('playwright-core');
  const server = createServer((req, res) => {
    if (req.url === '/hang') return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(article.replace('</body>', '<p id="rendered"></p><script>document.querySelector("#rendered").textContent="Rendered by JavaScript"</script></body>'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try { browser = await chromium.launch({ executablePath: process.env.SKIMLET_CHROMIUM, headless: true, args: ['--no-sandbox'] }); }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  const context = await browser.newContext(); await context.addCookies([{ name: 'session', value: 'fixture', url }]);
  const human = await context.newPage(); await human.goto(url);
  const adapter = new Extension(2, async () => ({ browser, sessionId: 'local-fixture', extensionBrowser: {}, async close() {} }));
  try {
    await adapter.page(new AbortController().signal, async page => {
      await page.goto(url); assert.match(await page.content(), /Rendered by JavaScript/);
      assert.match(await page.evaluate(() => document.cookie), /session=fixture/);
    });
    const abort = new AbortController();
    const pending = adapter.page(abort.signal, page => page.goto(url + '/hang'));
    await delay(100); abort.abort(); await assert.rejects(pending);
    await adapter.page(new AbortController().signal, page => page.goto(url));
    assert.equal(human.isClosed(), false); assert.equal(human.url(), url + '/');
    assert.equal(context.pages().length, 1);
  } finally { await adapter.close(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

let failed = 0, passed = 0;
for (const { name, run } of tests) {
  if (!process.env.SKIMLET_CHROMIUM && name.startsWith('Real local Chromium')) { console.log('SKIP real Chromium: set SKIMLET_CHROMIUM to a local test-browser executable'); continue; }
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n`, error); }
}
console.log(`${passed}/${passed + failed} selected checks passed`);
process.exitCode = failed ? 1 : 0;
