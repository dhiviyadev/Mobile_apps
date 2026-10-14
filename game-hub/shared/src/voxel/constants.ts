/** Voxel world dimensions and tuning shared by client and server. */

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 64;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT;

/** The world is finite: chunks from -WORLD_RADIUS_CHUNKS to WORLD_RADIUS_CHUNKS-1 on X and Z. */
export const WORLD_RADIUS_CHUNKS = 32;
export const WORLD_LIMIT = WORLD_RADIUS_CHUNKS * CHUNK_SIZE; // 512 blocks from origin

export const SEA_LEVEL = 24;

/** How far players can reach to break or place blocks (in blocks, from the eye). */
export const REACH = 6;

/** Player collision box. */
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_CROUCH_EYE = 1.32;

/** Full day/night cycle length in seconds. */
export const DAY_LENGTH_SECONDS = 600;
