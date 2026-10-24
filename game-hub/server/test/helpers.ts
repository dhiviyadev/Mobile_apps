/** Boots a real server on a random port for integration tests. */
import type { AddressInfo } from 'node:net';
import { Client } from '@colyseus/sdk';
import { PROTOCOL_VERSION } from '@hub/shared';
import { createGameServer, type GameServer, type GameServerOptions } from '../src/app';

export interface TestServer {
  server: GameServer;
  port: number;
  url: string;
  /** A client that sends PROTOCOL_VERSION, like the hub does. */
  client: () => Client;
  /** A client that sends no protocol version (a page from before versioning). */
  rawClient: () => Client;
  close: () => Promise<void>;
}

/** SDK client that sends PROTOCOL_VERSION with every matchmaking call, as the hub's NetSession does. */
export function versionedClient(url: string): Client {
  const c = new Client(url);
  for (const name of ['create', 'join', 'joinOrCreate', 'joinById'] as const) {
    const orig = (c[name] as unknown as (...a: unknown[]) => Promise<unknown>).bind(c);
    (c as unknown as Record<string, unknown>)[name] = (target: string, options?: object, ...rest: unknown[]) =>
      orig(target, { protocol: PROTOCOL_VERSION, ...options }, ...rest);
  }
  return c;
}

export async function startTestServer(options: Omit<GameServerOptions, 'gracefulShutdown'> = {}): Promise<TestServer> {
  const server = createGameServer({ ...options, gracefulShutdown: false });
  await server.listen(0, '127.0.0.1');
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  return {
    server,
    port,
    url,
    client: () => versionedClient(url),
    rawClient: () => new Client(url),
    close: async () => {
      await server.shutdown();
    },
  };
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until predicate is true or times out. */
export async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await wait(20);
  }
}
