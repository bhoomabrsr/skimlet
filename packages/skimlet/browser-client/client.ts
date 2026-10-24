import { randomUUID } from 'node:crypto';
import { chromium, type Browser } from 'playwright-core';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureRelay, relayPort } from '../relay-server/client.js';

type ExtensionStatus = { extensionId: string };
type RelaySession = { id: string; ownershipKey: string };
export type BrowserConnection = { browser: Browser; sessionId: string; close(): Promise<void> };

function endpoint(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}
async function getExtensions(port: number): Promise<ExtensionStatus[]> {
  const response = await fetch(endpoint(port, '/extensions/status'), { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Skimlet extension discovery failed (${response.status})`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('extensions' in data) || !Array.isArray(data.extensions)) {
    throw new Error('Invalid Skimlet extension status');
  }
  return data.extensions as ExtensionStatus[];
}
async function post(port: number, path: string, body: object): Promise<Response> {
  return fetch(endpoint(port, path), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(35_000),
  });
}
export async function createRelaySession(port: number, extensionId: string): Promise<RelaySession> {
  const response = await post(port, '/cli/session/new', { extensionId });
  const result = await response.json() as RelaySession & { error?: string };
  if (!response.ok || typeof result.id !== 'string' || typeof result.ownershipKey !== 'string') {
    throw new Error(result.error ?? 'Skimlet did not create a session');
  }
  return result;
}
export async function deleteRelaySession(port: number, session: RelaySession, closeCreatedTabs = true): Promise<void> {
  const response = await post(port, '/cli/session/delete', {
    sessionId: session.id, ownershipKey: session.ownershipKey, closeCreatedTabs,
  });
  if (response.status === 404) return;
  const result = await response.json() as { error?: string; warning?: string };
  if (!response.ok || result.warning) throw new Error(result.warning ?? result.error ?? 'Skimlet did not close the session');
}

/** Connect to Skimlet's relay and close only this connection's tabs on disposal. */
export async function connectViaExtension({ port = relayPort }: { port?: number } = {}): Promise<BrowserConnection> {
  if (port === relayPort) await ensureRelay();
  let extensions: ExtensionStatus[] = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    extensions = await getExtensions(port);
    if (extensions.length) break;
    await delay(200);
  }
  if (!extensions.length) {
    throw new Error('Skimlet Chrome extension is not connected. Load Skimlet in Chrome, click its icon on a web page to attach, then retry.');
  }
  if (extensions.length > 1) throw new Error('Multiple Skimlet extensions are connected. Disconnect all but one browser profile.');
  const extensionId = extensions[0].extensionId;
  const session = await createRelaySession(port, extensionId);
  const address = new URL(`ws://127.0.0.1:${port}/cdp/${randomUUID()}`);
  address.searchParams.set('extensionId', extensionId);
  address.searchParams.set('session', session.id);
  let browser: Browser;
  try { browser = await chromium.connectOverCDP(address.href); }
  catch (error) {
    await deleteRelaySession(port, session).catch(() => {});
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    browser, sessionId: session.id,
    close: () => closing ??= (async () => {
      await browser.close().catch(() => {});
      await deleteRelaySession(port, session);
    })(),
  };
}
