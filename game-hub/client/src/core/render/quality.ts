/**
 * Low / Medium / High quality presets. "Auto" picks one from a quick GPU
 * benchmark the first time a game starts (see benchmark.ts).
 */
import type { QualityPreset } from '../settings';

export interface QualityProfile {
  preset: QualityPreset;
  /** Upper bound for devicePixelRatio (before dynamic scaling). */
  maxPixelRatio: number;
  /** Lowest resolution scale dynamic resolution may drop to. */
  minRenderScale: number;
  antialias: boolean;
  /** Default voxel render distance in chunks (the slider can override). */
  voxelRenderDistance: number;
  /** Multiplier for particle counts and decorative effects. */
  effects: number;
  /** Frame rate dynamic resolution tries to hold. */
  targetFps: number;
}

export const QUALITY_PROFILES: Record<QualityPreset, QualityProfile> = {
  low: { preset: 'low', maxPixelRatio: 1, minRenderScale: 0.5, antialias: false, voxelRenderDistance: 3, effects: 0.4, targetFps: 30 },
  medium: { preset: 'medium', maxPixelRatio: 1.5, minRenderScale: 0.6, antialias: false, voxelRenderDistance: 4, effects: 0.75, targetFps: 60 },
  high: { preset: 'high', maxPixelRatio: 2, minRenderScale: 0.7, antialias: true, voxelRenderDistance: 6, effects: 1, targetFps: 60 },
};
