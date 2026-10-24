import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid ${name}`);
  return parsed;
}

export const relayPort = port(process.env.SKIMLET_PORT, 19989, 'SKIMLET_PORT');
export const { version: skimletVersion } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

async function inspect(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${relayPort}/version`, { signal: AbortSignal.timeout(3_000) });
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !value || typeof value !== 'object' || !('version' in value) || value.version !== skimletVersion
      || !('name' in value) || value.name !== 'skimlet') {
      throw new Error(`Port ${relayPort} is not the expected Skimlet ${skimletVersion} relay`);
    }
    return true;
  } catch (error) {
    if (error instanceof TypeError && error.cause && typeof error.cause === 'object'
      && 'code' in error.cause && error.cause.code === 'ECONNREFUSED') return false;
    throw error;
  }
}

let pending: Promise<number | undefined> | undefined;
export function ensureRelay(): Promise<number | undefined> {
  return pending ??= discover().finally(() => { pending = undefined; });
}

async function discover(): Promise<number | undefined> {
  if (await inspect()) return;

  const script = fileURLToPath(new URL('./server.js', import.meta.url));
  const child = spawn(process.execPath, [script], {
    detached: true, stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await inspect()) return child.pid;
    await delay(150);
  }
  throw new Error(`Skimlet relay did not start on port ${relayPort}. Check for another process on that port`);
}
