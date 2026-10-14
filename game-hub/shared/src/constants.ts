/**
 * Hub-wide constants shared by client and server.
 * Anything both sides must agree on (room names, limits, timing) lives here.
 */

export const HUB_NAME = 'Cobalt Game Hub';

/** Identifiers of the games in the hub. Also used as Colyseus room names. */
export const GAME_IDS = ['voxel', 'arena'] as const;
export type GameId = (typeof GAME_IDS)[number];

export const GAME_TITLES: Record<GameId, string> = {
  voxel: 'Voxelvale',
  arena: 'Arcfire Arena',
};

/** Voxel sandbox sub-modes. */
export const VOXEL_MODES = ['sandbox', 'parkour'] as const;
export type VoxelMode = (typeof VOXEL_MODES)[number];

/** Arena shooter match formats. */
export const ARENA_MODES = ['1v1', '2v2', 'ffa'] as const;
export type ArenaMode = (typeof ARENA_MODES)[number];

export interface ArenaModeInfo {
  label: string;
  /** Total player slots (humans + bots). */
  maxPlayers: number;
  /** Number of teams, 0 for free-for-all. */
  teams: number;
  /** Humans required before a public match auto-starts. */
  minHumansToStart: number;
}

export const ARENA_MODE_INFO: Record<ArenaMode, ArenaModeInfo> = {
  '1v1': { label: '1 vs 1', maxPlayers: 2, teams: 2, minHumansToStart: 2 },
  '2v2': { label: '2 vs 2', maxPlayers: 4, teams: 2, minHumansToStart: 4 },
  ffa: { label: 'Free-for-all', maxPlayers: 8, teams: 0, minHumansToStart: 3 },
};

export const VOXEL_MAX_PLAYERS = 16;

/** Private / shareable room codes. Ambiguous glyphs (0/O, 1/I) are excluded. */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** How long the server keeps a dropped player's seat for auto-reconnect. */
export const RECONNECT_WINDOW_SECONDS = 25;

export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 16;

export const CHAT_MAX_LENGTH = 120;
/** Chat rate limit: burst capacity and refill rate (messages per second). */
export const CHAT_BURST = 4;
export const CHAT_REFILL_PER_SECOND = 0.5;

export const DEFAULT_SERVER_PORT = 2567;
