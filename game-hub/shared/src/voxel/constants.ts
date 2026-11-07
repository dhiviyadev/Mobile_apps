/** Voxel world dimensions and tuning shared by client and server. */

export const CHUNK_SIZE = 16;
/** Build height: blocks exist at y 0..255 (edits and saves store y as a byte). */
export const CHUNK_HEIGHT = 256;
/** Cells in one horizontal layer of a chunk. */
export const CHUNK_LAYER = CHUNK_SIZE * CHUNK_SIZE;
/** Cells in a full-height chunk. Chunk arrays are usually shorter: see chunkLayers. */
export const CHUNK_VOLUME = CHUNK_LAYER * CHUNK_HEIGHT;
/**
 * Chunk arrays grow in whole vertical sections of this many layers: a chunk
 * array holds layers 0..chunkLayers-1 and everything above reads as air, so
 * memory and work follow what is built, not the full column.
 */
export const SECTION_HEIGHT = 16;
/**
 * Height of generated terrain. Every generator fills layers 0..63 only (the
 * world was 64 high when generators 1-3 were frozen) and returns arrays this
 * tall; generated terrain never changes with the build height.
 */
export const TERRAIN_HEIGHT = 64;
export const TERRAIN_VOLUME = CHUNK_LAYER * TERRAIN_HEIGHT;

/**
 * Generators 1 and 2 (and parkour) make a finite world: chunks from
 * -WORLD_RADIUS_CHUNKS to WORLD_RADIUS_CHUNKS-1 on X and Z.
 */
export const WORLD_RADIUS_CHUNKS = 32;
export const WORLD_LIMIT = WORLD_RADIUS_CHUNKS * CHUNK_SIZE; // 512 blocks from origin
/**
 * Generator 3 is endless up to what the wire format holds (edits use i16 x/z):
 * playable x, z in [-32000, 32000), a bedrock rim beyond.
 */
export const ENDLESS_RADIUS_CHUNKS = 2000;
export const ENDLESS_LIMIT = ENDLESS_RADIUS_CHUNKS * CHUNK_SIZE; // 32000 blocks from origin

export const SEA_LEVEL = 24;

/** Highest y flying creatures climb to (Duskwings retreating at dawn are removed above it). */
export const FLIGHT_CEILING = CHUNK_HEIGHT - 4;

/** How far players can reach to break or place blocks (in blocks, from the eye). */
export const REACH = 6;

/** Player collision box. */
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const PLAYER_CROUCH_EYE = 1.32;

/** Full day/night cycle length in seconds. */
export const DAY_LENGTH_SECONDS = 600;
