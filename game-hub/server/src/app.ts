/**
 * Builds the HTTP + Colyseus server. Kept separate from index.ts so tests can
 * boot a server on a random port.
 */
import http from 'node:http';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { corsHeaders, createRoutes, guardRequests } from './http/routes';
import { ArenaRoom } from './rooms/ArenaRoom';
import { VoxelRoom } from './rooms/VoxelRoom';
import { getWorldStore, setWorldStore, type WorldStore } from './voxel/WorldStore';

export interface GameServer {
  gameServer: Server;
  httpServer: http.Server;
  listen(port: number, host?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface GameServerOptions {
  gracefulShutdown?: boolean;
  /** Where voxel rooms save their worlds (defaults to whatever setWorldStore() installed, else memory). */
  worldStore?: WorldStore;
}

export function createGameServer(options: GameServerOptions = {}): GameServer {
  if (options.worldStore) setWorldStore(options.worldStore);
  // Colyseus' router answers every HTTP request: matchmaking plus our routes.
  const httpServer = http.createServer();
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, pingInterval: 4000, pingMaxRetries: 3 }),
    greet: false,
    gracefullyShutdown: options.gracefulShutdown ?? true,
  });
  gameServer.router = createRoutes() as unknown as typeof gameServer.router;
  matchMaker.controller.getCorsHeaders = corsHeaders;

  // filterBy(['mode']) makes quick match only pair players asking for the same mode.
  gameServer.define('voxel', VoxelRoom).filterBy(['mode']);
  gameServer.define('arena', ArenaRoom).filterBy(['mode']);
  // Shutdown waits for rooms still being disposed, but a room that began disposing just
  // before may still be writing its world: let those saves finish before the process exits.
  gameServer.onShutdown(() => getWorldStore().flush());

  return {
    gameServer,
    httpServer,
    listen: async (port, host) => {
      await gameServer.listen(port, host);
      // Colyseus adds its request listener while listening; ours goes in front of it.
      guardRequests(httpServer);
    },
    // Disposes every room first (voxel rooms save their world as it starts and on dispose).
    shutdown: () => gameServer.gracefullyShutdown(false),
  };
}
