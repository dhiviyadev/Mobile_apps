/**
 * Builds the HTTP + Colyseus server. Kept separate from index.ts so tests can
 * boot a server on a random port.
 */
import http from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { handleHttp } from './http/routes';
import { ArenaRoom } from './rooms/ArenaRoom';
import { VoxelRoom } from './rooms/VoxelRoom';

export interface GameServer {
  gameServer: Server;
  httpServer: http.Server;
  listen(port: number, host?: string): Promise<void>;
  shutdown(): Promise<void>;
}

export function createGameServer(options: { gracefulShutdown?: boolean } = {}): GameServer {
  const httpServer = http.createServer((req, res) => void handleHttp(req, res));
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer, pingInterval: 4000, pingMaxRetries: 3 }),
    greet: false,
    gracefullyShutdown: options.gracefulShutdown ?? true,
  });

  // filterBy(['mode']) makes quick match only pair players asking for the same mode.
  gameServer.define('voxel', VoxelRoom).filterBy(['mode']);
  gameServer.define('arena', ArenaRoom).filterBy(['mode']);

  return {
    gameServer,
    httpServer,
    listen: (port, host) => gameServer.listen(port, host),
    shutdown: () => gameServer.gracefullyShutdown(false),
  };
}
