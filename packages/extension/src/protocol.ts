export type Params = Record<string, unknown>;
export type RelayRequest = { id?: number; method: string; params: Params };
export type TargetInfo = { targetId: string; type: string; title: string; url: string; attached?: boolean; browserContextId?: string };
export type TabSession = { tabId: number; sessionId: string; targetInfo: TargetInfo; groupTitle: string; groupColor: chrome.tabGroups.TabGroup['color']; groupKey?: string };

export function isRecord(value: unknown): value is Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRequest(data: unknown): RelayRequest {
  if (typeof data !== 'string') throw new Error('Expected a JSON text message');
  const value: unknown = JSON.parse(data);
  if (!isRecord(value) || typeof value.method !== 'string') throw new Error('Missing message method');
  if (value.id !== undefined && (typeof value.id !== 'number' || !Number.isSafeInteger(value.id))) throw new Error('Invalid message ID');
  if (value.params !== undefined && !isRecord(value.params)) throw new Error('Invalid message parameters');
  return { id: value.id as number | undefined, method: value.method, params: (value.params || {}) as Params };
}

export function allowedUrl(url: string): boolean {
  return url === 'about:blank' || /^https?:\/\//.test(url);
}

export function assertSafeMethod(method: string): void {
  if (['Browser.close', 'Browser.crash', 'Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Storage.clearCookies'].includes(method)) {
    throw new Error('Profile-wide destructive commands are disabled');
  }
}

export function groupColor(value: unknown): chrome.tabGroups.TabGroup['color'] {
  const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  return typeof value === 'string' && colors.includes(value) ? value as chrome.tabGroups.TabGroup['color'] : 'green';
}
