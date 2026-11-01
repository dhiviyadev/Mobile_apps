/**
 * What surrounds the player: the biome and ruin banners, the biome fog tint and
 * bubbling lava nearby. Samples the generator at 4 Hz (about 10 µs).
 */
import * as THREE from 'three';
import { Biome, BIOME_INFO, Block, isBossDefeated, type BlockQuery, type StructureInfo, type WorldGenerator } from '@hub/shared';
import { audio } from '../../../core/audio/audio';

const SAMPLE_INTERVAL = 0.25;
/** A new biome must hold this long before its banner shows... */
const BIOME_HOLD = 1.5;
/** ...and banners are at least this far apart. */
const BANNER_GAP = 8;
const RUIN_DISTANCE = 40;

export interface SurroundingsHost {
  generator: WorldGenerator;
  getBlock: BlockQuery;
  showPlace(title: string, subtitle?: string): void;
}

export class Surroundings {
  /** Current fog tint and how strongly it applies (0..1), eased between biomes. */
  readonly fog = { color: new THREE.Color(0xffffff), weight: 0 };
  private readonly target = new THREE.Color(0xffffff);
  private targetWeight = 0;
  private sampleTimer = 0;
  private biome: Biome | null = null;
  private candidate: Biome | null = null;
  private candidateTime = 0;
  private bannerCooldown = 0;
  private readonly seenRuins = new Set<number>();
  private lavaTimer = 0.5;
  private bubbleTimer = 1;
  private lava: { x: number; y: number; z: number } | null = null;
  /** Last biome under the player (tests, dev hooks). */
  current: Biome | null = null;

  constructor(private readonly host: SurroundingsHost, private readonly enabled: boolean) {}

  update(dt: number, x: number, y: number, z: number, yaw: number): void {
    if (!this.enabled) return;
    this.bannerCooldown -= dt;
    this.sampleTimer -= dt;
    if (this.sampleTimer <= 0) {
      this.sampleTimer = SAMPLE_INTERVAL;
      this.sample(x, z);
    }
    // Ease the fog toward the biome's tint.
    const k = Math.min(1, dt * 0.5);
    this.fog.color.lerp(this.target, k);
    this.fog.weight += (this.targetWeight - this.fog.weight) * k;
    this.updateLava(dt, x, y, z, yaw);
  }

  private sample(x: number, z: number): void {
    const b = this.host.generator.biomeAt(Math.floor(x), Math.floor(z));
    this.current = b;
    const tint = BIOME_INFO[b]?.fogTint ?? 0;
    if (tint) this.target.setHex(tint);
    this.targetWeight = tint ? 1 : 0;

    // Ruins take priority over biome names.
    for (const s of this.host.generator.structuresNear(x, z, RUIN_DISTANCE)) {
      if (this.seenRuins.has(s.id)) continue;
      this.seenRuins.add(s.id);
      this.announceRuin(s);
      return;
    }
    if (b !== this.candidate) {
      this.candidate = b;
      this.candidateTime = 0;
    } else this.candidateTime += SAMPLE_INTERVAL;
    if (this.biome === null) {
      // The biome we start in is announced without waiting.
      this.biome = b;
      this.banner(BIOME_INFO[b].name);
    } else if (b !== this.biome && this.candidateTime >= BIOME_HOLD && this.bannerCooldown <= 0) {
      this.biome = b;
      this.banner(BIOME_INFO[b].name);
    }
  }

  private announceRuin(s: StructureInfo): void {
    const dormant = isBossDefeated(this.host.getBlock, s);
    this.host.showPlace(dormant ? 'Dormant ruins' : 'Ruins ahead', s.name);
    this.bannerCooldown = BANNER_GAP;
  }

  private banner(title: string): void {
    this.host.showPlace(title);
    this.bannerCooldown = BANNER_GAP;
  }

  /** Every 0.5 s, find the nearest lava within a 13x9x13 box; it bubbles every 1.5-3 s. */
  private updateLava(dt: number, x: number, y: number, z: number, yaw: number): void {
    this.lavaTimer -= dt;
    if (this.lavaTimer <= 0) {
      this.lavaTimer = 0.5;
      this.lava = null;
      let best = Infinity;
      const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
      for (let dy = -4; dy <= 4; dy++) {
        for (let dz = -6; dz <= 6; dz++) {
          for (let dx = -6; dx <= 6; dx++) {
            if (this.host.getBlock(fx + dx, fy + dy, fz + dz) !== Block.Lava) continue;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < best) {
              best = d;
              this.lava = { x: fx + dx + 0.5, y: fy + dy, z: fz + dz + 0.5 };
            }
          }
        }
      }
    }
    if (!this.lava) return;
    this.bubbleTimer -= dt;
    if (this.bubbleTimer > 0) return;
    this.bubbleTimer = 1.5 + Math.random() * 1.5;
    audio.playAt('lavaBubble', this.lava.x - x, this.lava.z - z, yaw, 16, 0.8);
  }
}
