/** Boots a real server on a random port for integration tests. */
import type { AddressInfo } from 'node:net';
import { Client } from 'colyseus.js';
import { createGameServer, type GameServer } from '../src/app';

export interface TestServer {
  server: GameServer;
  port: number;
  url: string;
  client: () => Client;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const server = createGameServer({ gracefulShutdown: false });
  await server.listen(0, '127.0.0.1');
  const port = (server.httpServer.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}`;
  return {
    server,
    port,
    url,
    client: () => new Client(url),
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
