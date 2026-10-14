/** Arcfire Arena tuning shared by client prediction, server and bots. */

/** Server simulation rate. */
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Client input command rate (each command simulates this much time). */
export const CMD_RATE = 60;
export const CMD_DT = 1 / CMD_RATE;

export const ROUNDS_TO_WIN = 5;
export const ROUND_TIME = 90;
export const LOADOUT_TIME = 6;
export const ROUND_END_TIME = 4;
export const MATCH_END_TIME = 12;
export const MAX_HP = 100;

/** Player body. Positions are feet positions in metres. */
export const PLAYER = {
  radius: 0.35,
  height: 1.75,
  crouchHeight: 1.3,
  eye: 1.6,
  crouchEye: 1.15,
  /** Hitbox split: head box size and how far it sits below the top. */
  headSize: 0.42,
} as const;

export const MOVE = {
  walkSpeed: 6,
  crouchSpeed: 3,
  gravity: 22,
  jumpVelocity: 7.2,
  groundAccel: 70,
  airAccel: 16,
  friction: 10,
  stepHeight: 0.45,
  maxFallSpeed: 40,
} as const;

/** Lag compensation never rewinds further than this (ms). */
export const MAX_REWIND_MS = 220;
/** How many ticks of hitbox history the server keeps. */
export const HISTORY_TICKS = 16;
