/** Arcfire Arena tuning shared by client prediction, server and bots. */

/** Server simulation rate. */
export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Client input command rate (each command simulates this much time). */
export const CMD_RATE = 60;
export const CMD_DT = 1 / CMD_RATE;

export const ROUNDS_TO_WIN = 5;
export const ROUND_TIME = 90;
/** Loadout phase before every round (8 s: room for the larger weapon roster). */
export const LOADOUT_TIME = 8;
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
  /** Eye while sliding (the hitbox stays the crouch box). */
  slideEye: 1.0,
  /** Hitbox split: head box size and how far it sits below the top. */
  headSize: 0.42,
} as const;

/**
 * Movement envelope (design-arena-movement §2/§3). FROZEN: the maps are validated against it,
 * so changing a value needs integrator sign-off.
 */
export const MOVE = {
  walkSpeed: 9,
  crouchSpeed: 4.2,
  gravity: 24,
  jumpVelocity: 8,
  groundAccel: 90,
  /** Ground deceleration with no stick input (9 → 0 m/s in 0.12 s). */
  groundDecel: 85,
  /**
   * Ground deceleration while faster than the target speed and still pushing roughly the same way
   * (after slides, slide-jumps, launches): max(overspeedDecel, excess × overspeedDamping).
   */
  overspeedDecel: 35,
  overspeedDamping: 8,
  airAccel: 20,
  stepHeight: 0.45,
  maxFallSpeed: 40,
  /** Safety clamp on horizontal speed. */
  maxHorizontalSpeed: 30,
} as const;

/** Slide: press crouch while running (design-arena-movement §3). Speeds in m/s, times in s. */
export const SLIDE = {
  /** Horizontal speed needed to start a slide. */
  minStartSpeed: 6.4,
  /** velocity·facing; forbids backwards slides. */
  minForwardDot: -0.2,
  /** Speed added at the start, but never past boostCap × speedMul (and never slowing you). */
  boost: 4,
  boostCap: 13,
  /** Cap on the speed gained sliding down stairs. */
  maxSpeed: 15,
  /** Linear deceleration on flat ground (m/s²). */
  decel: 7.5,
  /** Extra deceleration while the stick points against the slide (m/s²). */
  brake: 9,
  /** The slide ends below this speed... */
  endSpeed: 5,
  /** ...or after this long. */
  maxTime: 1.0,
  /** Steering toward the stick direction (rad/s). */
  turnRate: 1.8,
  /** Measured from slide start. */
  cooldown: 1.4,
  /** How long a slide request stays queued (press just before landing). */
  buffer: 0.3,
  /** Fraction of potential energy converted on stairs (down = faster, up = slower). */
  slopeGain: 0.7,
  /** Horizontal cap when jumping out of a slide. */
  jumpMaxSpeed: 12.5,
} as const;

/** Launch pads (trampolines, launchers, speed strips). */
export const PAD = {
  /** Cap on any launch (≈ 12 m apex). */
  maxVy: 24,
  /** Holding Jump on a trampoline ('keep' pads) launches this much faster. */
  jumpBonus: 1.12,
  /** |feet y − pad.top| must be within this to count as standing on the pad. */
  topTolerance: 0.05,
} as const;

/** Lag compensation never rewinds further than this (ms). */
export const MAX_REWIND_MS = 220;
/** How many ticks of hitbox history the server keeps. */
export const HISTORY_TICKS = 16;

/** Respawning pickups (design-arena-maps §4.2). */
export const PICKUP = {
  radius: 0.9,
  below: 0.5,
  above: 1.2,
  healthAmount: 50,
  healthRespawn: 20,
  ammoFraction: 0.5,
  ammoRespawn: 15,
  warmupRespawn: 8,
} as const;

/** Map vote (design-arena-maps §5.2). */
export const VOTE = { time: 15, allVotedTime: 3, revealTime: 3, candidates: 3, botVoteMin: 1.5, botVoteMax: 6, humanWeight: 1000 } as const;

/** Seconds into a live round after which roaming bots home in on the nearest enemy. */
export const BOT_HUNT_AFTER = 40;
