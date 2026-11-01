/**
 * Terrain generators. v1 is frozen (old worlds keep their terrain); v2 adds
 * biomes, ores and structures. Pick one through createWorldGenerator (generator.ts).
 */
export { Biome, BIOME_COUNT, BIOME_INFO, type BiomeInfo, type BiomeTag, TreeSpecies } from './biomes';
export { type Column, type Tree, TerrainGeneratorV1 } from './v1';
export { type ColumnV2, LAVA_LEVEL, TerrainGeneratorV2, type TreeV2 } from './v2';
/** @deprecated The original generator under its old name (= TerrainGeneratorV1). */
export { TerrainGeneratorV1 as TerrainGenerator } from './v1';
