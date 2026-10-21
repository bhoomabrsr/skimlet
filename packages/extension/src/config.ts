declare const SKIMLET_PROTOCOL_VERSION: string; // Replaced by esbuild at build time.
export const RELAY_HOST = '127.0.0.1';
export const RELAY_PORT = 19989;
export const PROTOCOL_VERSION = SKIMLET_PROTOCOL_VERSION;
export const DEFAULT_GROUP_TITLE = 'Skimlet';
export const BROWSER_LABEL = 'Chrome (Skimlet)';

export function relayUrl(): string {
  const url = new URL(`ws://${RELAY_HOST}:${RELAY_PORT}/extension`);
  url.searchParams.set('browser', BROWSER_LABEL);
  url.searchParams.set('capabilities', 'inventory-ready-v1');
  if (PROTOCOL_VERSION) url.searchParams.set('v', PROTOCOL_VERSION);
  return url.toString();
}
