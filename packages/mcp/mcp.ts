#!/usr/bin/env node
/** Skimlet: Google → owned concurrent tabs → readable content → MCP. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import Turndown from 'turndown';
import { pathToFileURL } from 'node:url';
import { googleHost, parseGoogle, searchReadySelector, searchUrl, type Result } from './adapters/google.js';
import { http } from './url.js';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** Node-side Playwriter connection and Skimlet tab limiter. */
import pLimit from 'p-limit';
import type { Page, PlaywriterBrowserConnection } from 'playwriter';

// Set before Playwriter starts its relay. An already-running relay keeps its own settings.
const relayPort = Number(process.env.SKIMLET_PORT ?? 19989);
if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error('Invalid SKIMLET_PORT');
process.env.PLAYWRITER_TELEMETRY = '0';
process.env.DO_NOT_TRACK = '1';

export type Connector = () => Promise<PlaywriterBrowserConnection>;
export const failure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('The Playwriter Chrome extension is not connected.')
    ? 'Skimlet Chrome extension is not connected. Load Skimlet in Chrome, click its icon on a web page to attach, then retry.'
    : message;
};

async function connect(): Promise<PlaywriterBrowserConnection> {
  await startRelay();
  const { connectViaExtension } = await import('playwriter');
  return connectViaExtension({ port: relayPort,
    tabGroup: 'Skimlet', tabGroupColor: 'blue', closeTabsOnEnd: true,
    logger: { log: () => {} },
  });
}

export class Extension {
  private readonly limit;
  private connection?: Promise<PlaywriterBrowserConnection>;
  private readonly active = new Set<Promise<unknown>>();
  private stopped = false;
  private closing?: Promise<void>;

  constructor(readonly tabs = 5, private readonly connector: Connector = connect) {
    if (!Number.isInteger(tabs) || tabs < 1 || tabs > 20) throw new Error('SKIMLET_TABS must be 1–20');
    this.limit = pLimit(tabs);
  }

  private getConnection() {
    this.connection ??= this.connector().then(connection => {
      connection.browser.once('disconnected', () => { this.connection = undefined; });
      return connection;
    }).catch(error => { this.connection = undefined; throw error; });
    return this.connection;
  }

  async ready() { await this.getConnection(); }

  /** The permit covers creation, navigation, capture, and confirmed tab closure. */
  async page<T>(signal: AbortSignal, read: (page: Page) => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error('browser_adapter_stopped');
    const task = this.limit(async () => {
      signal.throwIfAborted();
      if (this.stopped) throw new Error('browser_adapter_stopped');
      const connection = await this.getConnection();
      const { browser } = connection;
      const context = browser.contexts()[0];
      if (!context) throw new Error('no_browser_context');
      const page = await context.newPage().catch(async error => {
        // Creation can fail after Chrome opened the tab. Stop and clean this session.
        this.stopped = true;
        await connection.close();
        throw error;
      }); // Never select a human's existing page.
      let closing: Promise<void> | undefined;
      const close = () => closing ??= page.close({ runBeforeUnload: false });
      const abort = () => { void close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('popup', popup => { void popup.close().catch(() => {}); });
      page.on('download', download => { void download.cancel().catch(() => {}); });
      page.setDefaultTimeout(10_000);
      page.setDefaultNavigationTimeout(30_000);
      try {
        signal.throwIfAborted();
        return await read(page);
      } finally {
        signal.removeEventListener('abort', abort);
        try { await close(); }
        catch (error) {
          // Do not reuse capacity if Chrome might still have this tab open.
          if (!page.isClosed() && browser.isConnected()) {
            this.stopped = true;
            throw new Error(`tab_cleanup_failed: ${failure(error)}`);
          }
        }
      }
    });
    this.active.add(task);
    try { return await task; }
    finally { this.active.delete(task); }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true;
      await Promise.allSettled([...this.active]);
      const connection = await this.connection?.catch(() => undefined);
      await connection?.close(); // Playwriter closes only this session's owned tabs.
    })();
  }
}


// This process owns port 19989. Official Playwriter retains port 19988.
process.env.PLAYWRITER_PORT = String(relayPort);
process.env.PLAYWRITER_PATCHRIGHT = '0';
let relay: Promise<import('playwriter').RelayServer> | undefined;
export function startRelay() {
  return relay ??= (async () => {
    const { EXTENSION_IDS, startPlayWriterCDPRelayServer } = await import('playwriter');
    const manifest = JSON.parse(await readFile(new URL('../assets/manifest.json', import.meta.url), 'utf8'));
    const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
    const extensionId = [...hash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
    // Register only this extension's public identity in this relay process.
    EXTENSION_IDS.splice(0, EXTENSION_IDS.length, extensionId);
    return startPlayWriterCDPRelayServer({ port: relayPort, host: '127.0.0.1',
      logger: { log() {}, error() {} },
      cdpLogger: { log() {}, async flush() {}, logFilePath: '' },
    }); // EADDRINUSE fails; never stop or take over another relay.
  })();
}
export async function stopRelay() { (await relay?.catch(() => undefined))?.close(); relay = undefined; }


const MAX_RESPONSE_BYTES = 10_000_000;
const MAX_HTML_BYTES = 4_000_000;
export function extract(html: string, url: string, format: 'markdown' | 'text', maxChars: number) {
  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;
    doc.querySelectorAll('script, style, noscript, svg, nav, iframe').forEach(node => node.remove());
    doc.querySelectorAll('a[href]').forEach(anchor => {
      try { anchor.setAttribute('href', http(anchor.getAttribute('href')!, url).href); }
      catch { anchor.removeAttribute('href'); }
    });
    doc.querySelectorAll('img[src]').forEach(image => {
      try { image.setAttribute('src', http(image.getAttribute('src')!, url).href); }
      catch { image.remove(); }
    });
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    const content = format === 'markdown'
      ? new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article?.content || doc.body.innerHTML)
      : (article?.textContent || doc.body.textContent || '').trim();
    if (!content.trim()) throw new Error('empty_extraction');
    const chars = Array.from(content);
    return { content: chars.slice(0, maxChars).join(''), truncated: chars.length > maxChars,
      contentChars: chars.length, warning: article ? null : 'extractor_fallback' };
  } finally { dom.window.close(); }
}

export const inputSchema = z.object({
  queries: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
  engine: z.literal('google').default('google'),
  includeContent: z.boolean().default(true),
  format: z.enum(['markdown', 'text']).default('markdown'),
  maxContentChars: z.number().int().min(1).max(20_000).default(20_000),
}).strict();
type Input = z.infer<typeof inputSchema>;

export function createApp(extension = new Extension(Number(process.env.SKIMLET_TABS ?? 5))) {
  const server = new McpServer({ name: 'skimlet', version: '0.1.0' });
  const shutdown = new AbortController();
  let busy = false;

  async function capture(url: string, signal: AbortSignal, searchPage = false) {
    return extension.page(signal, async page => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400) throw new Error(`http_${response.status()}`);
      if (searchPage && googleHost(new URL(page.url()).hostname) && new URL(page.url()).pathname === '/search') {
        await page.locator(searchReadySelector).first().waitFor({ state: 'attached' }).catch(error => {
          if (signal.aborted || page.isClosed()) throw error; // Otherwise capture and classify the unexpected layout.
        });
      } else await page.locator('body').waitFor({ state: 'attached' });
      const html = await page.content();
      if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) throw new Error('page_too_large');
      return { html, url: page.url() };
    });
  }

  async function search(args: Input, signal: AbortSignal) {
    const contents = new Map<string, Promise<object>>();
    const queryResults = await Promise.all(args.queries.map(async (query, queryIndex) => {
      let rows: Result[] = [], error: string | null = null;
      const seen = new Set<string>(), visited = new Set<string>();
      let next: string | null = searchUrl(query);
      try {
        for (let count = 0; next && count < 3 && rows.length < 10 && !visited.has(next); count++) {
          visited.add(next);
          const captured = await capture(next, signal, true);
          const parsed = parseGoogle(captured.html, captured.url);
          for (const row of parsed.results) if (!seen.has(row.url) && rows.length < 10) {
            seen.add(row.url); rows.push({ ...row, rank: rows.length + 1 });
          }
          next = parsed.next;
        }
      } catch (cause) { error = signal.aborted ? 'cancelled_or_deadline' : failure(cause); }

      // All search leases are released before destination work enters the same limiter.
      const results = await Promise.all(rows.map(async row => {
        const base = { ...row, resultId: `q${queryIndex}:r${row.rank}` };
        if (!args.includeContent) return { ...base, finalUrl: null, contentStatus: 'not_requested' };
        let pending = contents.get(row.url);
        if (!pending) {
          pending = (async () => {
            let finalUrl: string | null = null;
            try {
              const captured = await capture(row.url, signal);
              finalUrl = captured.url;
              const final = http(captured.url);
              if (row.linkStatus === 'unresolved' && (googleHost(final.hostname) || /^(consent|accounts)\.google\./.test(final.hostname))) throw new Error('unresolved_link');
              signal.throwIfAborted();
              return { finalUrl: captured.url, contentStatus: 'success', format: args.format,
                ...extract(captured.html, captured.url, args.format, args.maxContentChars) };
            } catch (cause) { return { finalUrl, contentStatus: 'failed', error: signal.aborted ? 'cancelled_or_deadline' : failure(cause) }; }
          })();
          contents.set(row.url, pending);
        }
        const content = await pending;
        return { ...base, ...content, linkStatus: 'contentStatus' in content && content.contentStatus === 'success' && row.linkStatus === 'unresolved' ? 'resolved' : row.linkStatus };
      }));
      return { query, queryId: `q${queryIndex}`, status: error ? 'error' : 'ok', error,
        shortfall: rows.length < 10 ? 'fewer_results_collected' : null, results };
    }));
    return { engine: 'google', queries: queryResults };
  }

  server.registerTool('search', {
    description: 'Search Google in your connected Chrome profile. Up to 10 queries, up to 10 organic results each, optional Markdown/text. Page content is capped with an explicit truncated flag. One batch at a time; tabs run concurrently.',
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (args, extra) => {
    if (busy) return { isError: true, content: [{ type: 'text', text: 'busy: another batch is running' }] };
    busy = true;
    const signal = AbortSignal.any([extra.signal, shutdown.signal, AbortSignal.timeout(120_000)]);
    try {
      await extension.ready();
      signal.throwIfAborted();
      const value = await search(args, signal);
      const reply = { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
      if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response_too_large: reduce queries or maxContentChars');
      return reply;
    } catch (error) { return { isError: true, content: [{ type: 'text', text: failure(error) }] }; }
    finally { busy = false; }
  });
  return { server, async close() { shutdown.abort(); await extension.close(); await server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await startRelay();
  console.error(`Skimlet ready on 127.0.0.1:${relayPort}. Click the Skimlet extension to connect.`);
  const app = createApp();
  const close = async () => { try { await app.close(); } finally { await stopRelay(); } };
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => { void close().catch(console.error); });
  process.stdin.once('end', () => { void close().catch(console.error); });
  await app.server.connect(new StdioServerTransport());
}
