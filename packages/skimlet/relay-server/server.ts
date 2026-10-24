#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { relayPort } from './client.js';

type Data = Record<string, unknown>;
type Target = { sessionId: string; targetId: string; targetInfo: Data; parentSessionId?: string };
type Extension = {
  id: string; ws: WebSocket; browser: string; version: string | null; ready: boolean;
  targets: Map<string, Target>; pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  nextId: number;
};
type Session = { id: string; key: string; extension: Extension; targets: Set<string>; clients: Set<WebSocket> };

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const manifest = JSON.parse(readFileSync(new URL('../../assets/manifest.json', import.meta.url), 'utf8')) as { key: string };
const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
const unpackedId = [...hash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const origins = new Set(['chrome-extension://fiipfignceankihmkhfjldmniofechoh', `chrome-extension://${unpackedId}`]);
const extensions = new Map<string, Extension>();
const sessions = new Map<string, Session>();
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function record(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function send(ws: WebSocket, message: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
function validHost(request: IncomingMessage) {
  return request.headers.host === `127.0.0.1:${relayPort}` || request.headers.host === `localhost:${relayPort}`;
}
function rejectSocket(socket: import('node:stream').Duplex, status: number) {
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Not Found'}\r\nConnection: close\r\n\r\n`);
}
function selectedExtension(id: string | null): Extension | undefined {
  if (id) return extensions.get(id);
  return extensions.size === 1 ? extensions.values().next().value : undefined;
}
function requestExtension(extension: Extension, method: string, params: Data): Promise<unknown> {
  if (extension.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Extension disconnected'));
  const id = ++extension.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      extension.pending.delete(id);
      reject(new Error(`Extension request timed out: ${method}`));
    }, 30_000);
    extension.pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    send(extension.ws, { id, method, params });
  });
}
function ownedTargets(session: Session): Target[] {
  return [...session.targets].map(id => session.extension.targets.get(id)).filter((target): target is Target => !!target);
}
function owner(extension: Extension, target: Target): Session | undefined {
  return [...sessions.values()].find(session => session.extension === extension && session.targets.has(target.sessionId));
}
function emit(session: Session, event: Data) {
  for (const client of session.clients) send(client, event);
}
function extensionMessage(extension: Extension, raw: WebSocket.RawData) {
  let message: Data;
  try { message = JSON.parse(raw.toString()) as Data; } catch { extension.ws.close(1003); return; }
  if (!record(message)) { extension.ws.close(1003); return; }
  if (message.method === 'ready') { extension.ready = true; return; }
  if (typeof message.id === 'number') {
    const pending = extension.pending.get(message.id);
    if (!pending) return;
    extension.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result);
    return;
  }
  if (message.method !== 'forwardCDPEvent' || !record(message.params)) return;
  const { method, params, sessionId } = message.params;
  if (typeof method !== 'string' || !record(params)) return;
  if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string' && record(params.targetInfo)
    && typeof params.targetInfo.targetId === 'string') {
    const target: Target = { sessionId: params.sessionId, targetId: params.targetInfo.targetId,
      targetInfo: params.targetInfo, ...(typeof sessionId === 'string' ? { parentSessionId: sessionId } : {}) };
    extension.targets.set(target.sessionId, target);
    // New root tabs are assigned only after createTarget returns; never broadcast human tabs.
    const parent = target.parentSessionId && extension.targets.get(target.parentSessionId);
    const parentOwner = parent && owner(extension, parent);
    if (parentOwner) {
      parentOwner.targets.add(target.sessionId);
      emit(parentOwner, { method, params, sessionId: target.parentSessionId });
    } else if (params.waitingForDebugger === true) {
      void requestExtension(extension, 'forwardCDPCommand', {
        method: 'Runtime.runIfWaitingForDebugger', sessionId: target.sessionId, params: {},
      }).catch(() => {});
    }
    return;
  }
  if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
    const target = extension.targets.get(params.sessionId);
    if (!target) return;
    const session = owner(extension, target);
    if (session) { emit(session, { method, params, ...(typeof sessionId === 'string' ? { sessionId } : {}) }); session.targets.delete(target.sessionId); }
    extension.targets.delete(target.sessionId);
    return;
  }
  if (method === 'Target.targetInfoChanged' && record(params.targetInfo) && typeof params.targetInfo.targetId === 'string') {
    const info = params.targetInfo;
    const target = [...extension.targets.values()].find(item => item.targetId === info.targetId);
    if (target) target.targetInfo = info;
  }
  const target = typeof sessionId === 'string' ? extension.targets.get(sessionId) : undefined;
  const session = target && owner(extension, target);
  if (session) emit(session, { method, params, sessionId });
}

async function command(session: Session, method: string, params: Data, sessionId?: string): Promise<unknown> {
  const extension = session.extension;
  const targets = ownedTargets(session);
  if (method === 'Browser.getVersion') return { protocolVersion: '1.3', product: 'Chrome/Extension-Bridge', revision: '1.0.0', userAgent: 'CDP-Bridge-Server/1.0.0', jsVersion: 'V8' };
  if (method === 'Browser.setDownloadBehavior' || method === 'Target.setDiscoverTargets') return {};
  if (method === 'Target.getBrowserContexts') return { browserContextIds: [] };
  if (method === 'Target.getTargets') return { targetInfos: targets.map(t => ({ ...t.targetInfo, attached: true })) };
  if (method === 'Target.getTargetInfo') {
    const target = targets.find(t => t.targetId === params.targetId || t.sessionId === sessionId) ?? (params.targetId || sessionId ? undefined : targets[0]);
    if (!target && (params.targetId || sessionId)) throw new Error('Target does not belong to this session');
    return { targetInfo: target?.targetInfo };
  }
  if (method === 'Target.attachToTarget') {
    const target = targets.find(t => t.targetId === params.targetId);
    if (!target) throw new Error('Target does not belong to this session');
    emit(session, { method: 'Target.attachedToTarget', params: { sessionId: target.sessionId,
      targetInfo: { ...target.targetInfo, attached: true }, waitingForDebugger: false } });
    return { sessionId: target.sessionId };
  }
  if (method === 'Target.setAutoAttach' && !sessionId) {
    await requestExtension(extension, 'forwardCDPCommand', { method, params });
    return {};
  }
  if (method === 'Target.createTarget') {
    const result = await requestExtension(extension, 'forwardCDPCommand', { method, params, tabGroup: 'Skimlet',
      tabGroupColor: 'blue', tabGroupKey: session.key });
    if (!record(result) || typeof result.targetId !== 'string') throw new Error('Extension did not create a target');
    const target = [...extension.targets.values()].find(t => t.targetId === result.targetId);
    if (!target) throw new Error('Extension did not announce the new target');
    session.targets.add(target.sessionId);
    emit(session, { method: 'Target.attachedToTarget', params: { sessionId: target.sessionId,
      targetInfo: { ...target.targetInfo, attached: true }, waitingForDebugger: false } });
    return result;
  }
  if (method === 'Target.closeTarget') {
    if (!targets.some(t => t.targetId === params.targetId)) throw new Error('Target does not belong to this session');
  } else if (!sessionId || !session.targets.has(sessionId)) {
    throw new Error('Target does not belong to this session');
  }
  return requestExtension(extension, 'forwardCDPCommand', { method, params, ...(sessionId ? { sessionId } : {}) });
}
function clientMessage(session: Session, ws: WebSocket, raw: WebSocket.RawData) {
  let message: Data;
  try { message = JSON.parse(raw.toString()) as Data; } catch { ws.close(1003); return; }
  if (!record(message) || typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || typeof message.method !== 'string') { ws.close(1003); return; }
  const id = message.id;
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
  void command(session, message.method, record(message.params) ? message.params : {}, sessionId).then(
    result => send(ws, { id, ...(sessionId ? { sessionId } : {}), result }),
    error => send(ws, { id, ...(sessionId ? { sessionId } : {}), error: { message: String(error instanceof Error ? error.message : error) } }),
  );
}

async function body(request: IncomingMessage): Promise<Data> {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 16_384) throw new Error('Request body is too large');
  }
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error('Expected a JSON object');
  return value;
}
async function handle(request: IncomingMessage, response: ServerResponse) {
  if (!validHost(request) || ![undefined, 'same-origin', 'none'].includes(request.headers['sec-fetch-site'] as string | undefined)) {
    json(response, 403, { error: 'Forbidden' }); return;
  }
  try {
    const route = new URL(request.url ?? '/', `http://127.0.0.1:${relayPort}`).pathname;
    if (request.method === 'GET' && route === '/version') {
      json(response, 200, { version: pkg.version, name: 'skimlet' }); return;
    }
    if (request.method === 'GET' && route === '/extensions/status') {
      json(response, 200, { extensions: [...extensions.values()].filter(e => e.ready).map(e => ({ extensionId: e.id,
        browser: e.browser, activeTargets: e.targets.size, protocolVersion: e.version })) }); return;
    }
    if (request.method === 'GET' && route === '/extension/status') {
      const extension = selectedExtension(null);
      json(response, 200, { connected: !!extension?.ready, activeTargets: extension?.targets.size ?? 0,
        protocolVersion: extension?.version ?? null }); return;
    }
    if (request.method === 'POST' && route === '/cli/session/new') {
      const value = await body(request);
      const extension = selectedExtension(typeof value.extensionId === 'string' ? value.extensionId : null);
      if (!extension?.ready) { json(response, 404, { error: 'Extension not connected' }); return; }
      const id = randomUUID();
      const session: Session = { id, key: `${randomUUID()}:${id}`, extension, targets: new Set(), clients: new Set() };
      sessions.set(id, session);
      json(response, 200, { id, ownershipKey: session.key }); return;
    }
    if (request.method === 'POST' && route === '/cli/session/delete') {
      const value = await body(request);
      const session = typeof value.sessionId === 'string' ? sessions.get(value.sessionId) : undefined;
      if (!session) { json(response, 404, { error: 'Session not found' }); return; }
      if (value.ownershipKey !== session.key) { json(response, 409, { error: 'Session ownership key does not match' }); return; }
      sessions.delete(session.id);
      for (const ws of session.clients) ws.close(1000, 'Session closed');
      let warning: string | undefined;
      if (value.closeCreatedTabs) {
        try {
          const result = await requestExtension(session.extension, 'closeTabsForKey', { key: session.key });
          if (!record(result) || result.success !== true) warning = 'Extension did not confirm tab cleanup';
        } catch (error) { warning = `Could not close session tabs: ${String(error)}`; }
      }
      json(response, 200, { success: true, ...(warning ? { warning } : {}) }); return;
    }
    json(response, 404, { error: 'Not found' });
  } catch (error) { json(response, 400, { error: String(error instanceof Error ? error.message : error) }); }
}

const server = createServer((request, response) => { void handle(request, response); });
server.on('upgrade', (request, socket, head) => {
  if (!validHost(request)) { rejectSocket(socket, 403); return; }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${relayPort}`);
  if (url.pathname === '/extension') {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !origins.has(origin) || extensions.has(origin)) { rejectSocket(socket, 403); return; }
    webSockets.handleUpgrade(request, socket, head, ws => {
      const extension: Extension = { id: origin, ws, browser: url.searchParams.get('browser') ?? 'Chrome',
        version: url.searchParams.get('v'), ready: false, targets: new Map(), pending: new Map(), nextId: 0 };
      extensions.set(origin, extension);
      const heartbeat = setInterval(() => send(ws, { method: 'ping' }), 20_000);
      ws.on('message', raw => extensionMessage(extension, raw));
      ws.on('error', error => console.error('Extension socket error:', error));
      ws.on('close', () => {
        clearInterval(heartbeat);
        if (extensions.get(origin) === extension) extensions.delete(origin);
        for (const pending of extension.pending.values()) pending.reject(new Error('Extension disconnected'));
        extension.pending.clear(); extension.targets.clear();
        for (const session of sessions.values()) if (session.extension === extension) {
          for (const client of session.clients) client.close(1011, 'Extension disconnected');
        }
      });
    });
    return;
  }
  if (/^\/cdp\/[^/]+$/.test(url.pathname)) {
    if (request.headers.origin) { rejectSocket(socket, 403); return; }
    const session = sessions.get(url.searchParams.get('session') ?? '');
    if (!session || session.extension !== selectedExtension(url.searchParams.get('extensionId')) || !session.extension.ready) {
      rejectSocket(socket, 403); return;
    }
    webSockets.handleUpgrade(request, socket, head, ws => {
      session.clients.add(ws);
      ws.on('message', raw => clientMessage(session, ws, raw));
      ws.on('error', error => console.error('Browser client socket error:', error));
      ws.on('close', () => { session.clients.delete(ws); });
    });
    return;
  }
  rejectSocket(socket, 404);
});

let running: Promise<void> | undefined;
export function startRelay(): Promise<void> {
  return running ??= new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(relayPort, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  }).catch(error => { running = undefined; throw error; });
}
export async function stopRelay() {
  if (!running) return;
  for (const ws of webSockets.clients) ws.terminate();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  running = undefined;
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await startRelay();
  console.error(`Skimlet relay ready on 127.0.0.1:${relayPort}`);
  for (const event of ['SIGINT', 'SIGTERM'] as const) {
    process.once(event, () => { void stopRelay().catch(error => { console.error(error); process.exitCode = 1; }); });
  }
}
