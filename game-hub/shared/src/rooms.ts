/**
 * Room/lobby related types and helpers used on both ends of the wire.
 */
import {
  ARENA_MODES,
  type ArenaMode,
  type GameId,
  GAME_IDS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  VOXEL_MODES,
  type VoxelMode,
} from './constants';

/** Options a client sends when creating or joining a room. */
export interface JoinOptions {
  nickname: string;
  /** Game-specific mode (VoxelMode or ArenaMode). */
  mode?: string;
  /** When creating: hide from quick match and the public room list. */
  private?: boolean;
  /** Preferred avatar colour (0xRRGGBB). */
  color?: number;
  /**
   * Voxelvale: reopen the saved world with this room code (sent with
   * create('voxel') after joinById found no open room).
   */
  reviveCode?: string;
}

/** Markers in the error message when reopening a saved world fails. */
export const REVIVE_ERRORS = {
  /** No saved world has that code (never existed, or expired). */
  noSavedWorld: 'NO_SAVED_WORLD',
  /** A room with that code is already open (or still closing): join it instead. */
  alreadyOpen: 'ROOM_ALREADY_OPEN',
} as const;

/** Metadata each room publishes for listings. */
export interface RoomMeta {
  code: string;
  mode: string;
  private: boolean;
  /** Short human description, e.g. "Round 3 · 2-1" or "Waiting for players". */
  status?: string;
}

/** Shape returned by the server's GET /api/rooms endpoint. */
export interface RoomListing {
  roomId: string;
  game: GameId;
  mode: string;
  clients: number;
  maxClients: number;
  locked: boolean;
  status?: string;
}

export interface RoomListResponse {
  rooms: RoomListing[];
  /** Total connected players per game, including private rooms. */
  online: Record<GameId, number>;
}

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);
}

export function isVoxelMode(value: unknown): value is VoxelMode {
  return typeof value === 'string' && (VOXEL_MODES as readonly string[]).includes(value);
}

export function isArenaMode(value: unknown): value is ArenaMode {
  return typeof value === 'string' && (ARENA_MODES as readonly string[]).includes(value);
}

/** Uppercases and strips anything that cannot appear in a room code. */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Generates a random room code using the supplied RNG (defaults to Math.random). */
export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
