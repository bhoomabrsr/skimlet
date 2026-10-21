import { DEFAULT_GROUP_TITLE, relayUrl } from './config.js';
import { allowedUrl, assertSafeMethod, groupColor, isRecord, parseRequest, type Params, type RelayRequest, type TabSession, type TargetInfo } from './protocol.js';

const tabs = new Map<number, TabSession>();
const children = new Map<string, { tabId: number; targetId: string; parentSessionId: string }>();
const sessionPrefix = crypto.randomUUID();
let nextSessionId = 0;
let socket: WebSocket | null = null;
let opening: Promise<void> | null = null;
let actions: Promise<unknown> = Promise.resolve();
let autoAttach: Params | undefined;

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = actions.then(action);
  actions = result.catch(error => console.error(error));
  return result;
}

async function setIcon(tabId: number, enabled: boolean, error?: string) {
  await Promise.all([
    chrome.action.setIcon({ tabId, path: enabled ? 'icons/on.png' : 'icons/off.png' }),
    chrome.action.setTitle({ tabId, title: error || (enabled ? 'Connected to Skimlet. Click to detach' : 'Attach this tab to Skimlet') }),
  ]).catch(() => {}); // Closed tabs no longer have an action icon.
}

function send(message: unknown, connection = socket) {
  if (connection?.readyState !== WebSocket.OPEN) return;
  if (connection.bufferedAmount > 16 * 1024 * 1024) { connection.close(); return; }
  connection.send(JSON.stringify(message));
}

function event(method: string, params: object, sessionId?: string) {
  send({ method: 'forwardCDPEvent', params: { method, params, ...(sessionId ? { sessionId } : {}) } });
}

function announce(tab: TabSession) {
  event('Target.attachedToTarget', { sessionId: tab.sessionId, targetInfo: { ...tab.targetInfo, attached: true }, waitingForDebugger: false });
}

function forgetChild(sessionId: string) {
  const child = children.get(sessionId);
  if (!child) return;
  for (const [id, descendant] of children) if (descendant.parentSessionId === sessionId) forgetChild(id);
  children.delete(sessionId);
  event('Target.detachedFromTarget', { sessionId, targetId: child.targetId }, child.parentSessionId);
}

function forget(tabId: number) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tabs.delete(tabId);
  for (const [id, child] of children) if (child.tabId === tabId) forgetChild(id);
  event('Target.detachedFromTarget', { sessionId: tab.sessionId, targetId: tab.targetInfo.targetId });
  void setIcon(tabId, false);
}

async function detach(tabId: number) {
  if (!tabs.has(tabId)) return;
  forget(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function groupTab(tabId: number, options: Params) {
  const tab = await chrome.tabs.get(tabId);
  const title = typeof options.tabGroup === 'string' && options.tabGroup.trim()
    ? options.tabGroup.trim().slice(0, 80) : DEFAULT_GROUP_TITLE;
  const color = groupColor(options.tabGroupColor);
  // The query title is a glob; compare exact titles instead of matching user wildcards.
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId });
  const existing = groups.find(group => group.title === title);
  const groupId = await chrome.tabs.group({ tabIds: [tabId], ...(existing ? { groupId: existing.id } : {}) });
  await chrome.tabGroups.update(groupId, { title, color });
  return { groupTitle: title, groupColor: color, groupKey: typeof options.tabGroupKey === 'string' ? options.tabGroupKey : undefined };
}

async function attach(tabId: number, options: Params = {}, announceTarget = true): Promise<TabSession> {
  const existing = tabs.get(tabId);
  if (existing) return existing;
  const connection = socket;
  if (connection?.readyState !== WebSocket.OPEN) throw new Error('Skimlet relay is not connected');
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
    const { targetInfo } = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo') as { targetInfo: TargetInfo };
    if (!targetInfo?.targetId || !allowedUrl(targetInfo.url)) throw new Error('Only web pages and about:blank are supported');
    const group = await groupTab(tabId, options);
    const session: TabSession = { tabId, sessionId: `skimlet-${sessionPrefix}-${++nextSessionId}`, targetInfo, ...group };
    tabs.set(tabId, session);
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    if (socket !== connection || connection.readyState !== WebSocket.OPEN || tabs.get(tabId) !== session) throw new Error('Connection changed during attachment');
    if (announceTarget) announce(session);
    if (autoAttach) await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', autoAttach);
    await setIcon(tabId, true);
    return session;
  } catch (error) {
    forget(tabId);
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    throw error;
  }
}

async function createTab(options: Params, announceTarget = true) {
  const url = typeof options.url === 'string' ? options.url : 'about:blank';
  if (!allowedUrl(url)) throw new Error('Only web pages and about:blank are supported');
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error('Chrome did not create a tab');
  try { return await attach(tab.id, options, announceTarget); }
  catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
}

function resolveSession(params: Params): { tab: TabSession; debuggee: chrome.debugger.DebuggerSession } | undefined {
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  if (sessionId && children.has(sessionId)) {
    const tab = tabs.get(children.get(sessionId)!.tabId);
    if (tab) return { tab, debuggee: { tabId: tab.tabId, sessionId } };
  }
  const targetId = isRecord(params.params) ? params.params.targetId : undefined;
  const tab = [...tabs.values()].find(tab => tab.sessionId === sessionId || (typeof targetId === 'string' && tab.targetInfo.targetId === targetId));
  return tab ? { tab, debuggee: { tabId: tab.tabId } } : undefined;
}

async function forward(params: Params): Promise<unknown> {
  if (typeof params.method !== 'string') throw new Error('Missing CDP method');
  const method = params.method;
  const arguments_ = isRecord(params.params) ? params.params : {};
  assertSafeMethod(method);
  if (method === 'Target.setAutoAttach' && !params.sessionId) {
    autoAttach = arguments_;
    await Promise.all([...tabs.keys()].map(tabId => chrome.debugger.sendCommand({ tabId }, method, arguments_)));
    return {};
  }
  if (method === 'Target.createTarget') {
    const tab = await serialize(() => createTab({ ...params, url: arguments_.url }));
    return { targetId: tab.targetInfo.targetId };
  }
  const resolved = resolveSession(params);
  if (!resolved) {
    if (method === 'Target.closeTarget') return { success: false };
    if (method === 'Target.detachFromTarget') return {};
    throw new Error('Unknown or detached target session');
  }
  if (method === 'Target.closeTarget') {
    await chrome.tabs.remove(resolved.tab.tabId);
    forget(resolved.tab.tabId);
    return { success: true };
  }
  if (method === 'Target.attachToTarget') throw new Error('Direct target attachment is not supported');
  // Chrome emits existing execution contexts only on the first enable. Re-enable for new clients.
  if (method === 'Runtime.enable') await chrome.debugger.sendCommand(resolved.debuggee, 'Runtime.disable').catch(() => {});
  return await chrome.debugger.sendCommand(resolved.debuggee, method, arguments_) ?? {};
}

async function dispatch(request: RelayRequest): Promise<unknown> {
  if (request.method === 'forwardCDPCommand') return forward(request.params);
  if (request.method === 'createInitialTab') {
    const tab = await serialize(() => createTab(request.params, false));
    return { success: true, tabId: tab.tabId, sessionId: tab.sessionId, targetInfo: tab.targetInfo };
  }
  if (request.method === 'closeTabsForKey') {
    if (typeof request.params.key !== 'string') throw new Error('A session ownership key is required');
    return serialize(async () => {
      const owned = [...tabs.values()].filter(tab => tab.groupKey === request.params.key);
      for (const tab of owned) { await chrome.tabs.remove(tab.tabId); forget(tab.tabId); }
      return { success: true, closedTabs: owned.length };
    });
  }
  if (request.method === 'setRecorderState') return {}; // There is no recorder UI to update.
  throw new Error(`Unsupported extension request: ${request.method}`);
}

function connect(): Promise<void> {
  if (opening) return opening;
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  opening = new Promise<void>((resolve, reject) => {
    const connection = new WebSocket(relayUrl());
    socket = connection;
    let settled = false;
    const timer = setTimeout(() => { finish(new Error('Skimlet relay connection timed out')); connection.close(); }, 5000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    connection.onopen = () => {
      if (settled || socket !== connection) { connection.close(); return; }
      for (const tab of tabs.values()) announce(tab);
      send({ method: 'ready' }, connection);
      finish();
    };
    connection.onmessage = message => {
      let request: RelayRequest;
      try { request = parseRequest(message.data); }
      catch { connection.close(4000, 'Invalid relay message'); return; }
      if (request.method === 'ping') { send({ method: 'pong' }, connection); return; }
      void dispatch(request).then(
        result => { if (request.id !== undefined) send({ id: request.id, result }, connection); },
        error => { if (request.id !== undefined) send({ id: request.id, error: error instanceof Error ? error.message : String(error) }, connection); },
      );
    };
    connection.onerror = () => finish(new Error('Cannot connect to Skimlet; start the MCP server and check its port'));
    connection.onclose = () => {
      finish(new Error('Skimlet relay disconnected'));
      if (socket !== connection) return;
      socket = null;
      autoAttach = undefined;
      void serialize(() => Promise.all([...tabs.keys()].map(detach)));
    };
  }).finally(() => { opening = null; });
  return opening;
}

export function toggleTab(tab: chrome.tabs.Tab): Promise<void> {
  return serialize(async () => {
    if (tab.id === undefined) return;
    try {
      if (tabs.has(tab.id)) { await detach(tab.id); return; }
      if (!allowedUrl(tab.url || '')) throw new Error('Choose a web page');
      await connect();
      await attach(tab.id);
    } catch (error) {
      await setIcon(tab.id, false, error instanceof Error ? error.message : String(error));
    }
  });
}

chrome.action.onClicked.addListener(toggleTab);
chrome.debugger.onDetach.addListener(({ tabId }) => { if (tabId !== undefined) forget(tabId); });
chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  if (source.tabId === undefined) return;
  const tab = tabs.get(source.tabId);
  if (!tab) return;
  const data = params as Params;
  if (method === 'Target.attachedToTarget' && typeof data.sessionId === 'string') {
    const info = data.targetInfo as TargetInfo | undefined;
    if (info?.type !== 'iframe' || /^(chrome|chrome-extension|devtools|edge):/.test(info.url)) {
      void chrome.debugger.sendCommand(source, 'Target.detachFromTarget', { sessionId: data.sessionId }).catch(console.error);
      return;
    }
    children.set(data.sessionId, { tabId: source.tabId, targetId: info.targetId, parentSessionId: source.sessionId || tab.sessionId });
  }
  if (method === 'Target.detachedFromTarget' && typeof data.sessionId === 'string') {
    forgetChild(data.sessionId);
    return;
  }
  event(method, params, source.sessionId || tab.sessionId);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  const tab = tabs.get(tabId);
  if (!tab || !(change.url || change.title || change.status === 'complete')) return;
  void chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo').then(result => {
    if (tabs.get(tabId) !== tab) return;
    tab.targetInfo = (result as { targetInfo: TargetInfo }).targetInfo;
    event('Target.targetInfoChanged', { targetInfo: { ...tab.targetInfo, attached: true } });
  }).catch(() => {});
});

// Discoverable by the Skimlet MCP relay before it requests its first tab. No automatic retry loop.
void connect().catch(error => console.warn(error.message));
