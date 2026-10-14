/**
 * Targeting, breaking (hold, with crack stages and per-block hardness) and
 * placing (tap, or hold to keep placing) blocks at the crosshair.
 */
import * as THREE from 'three';
import {
  Block,
  type BlockQuery,
  blockDef,
  CHUNK_HEIGHT,
  IS_LIQUID,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  raycastVoxels,
  REACH,
  type VoxelHit,
} from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { InputFrame } from '../../../core/input/InputManager';
import type { BlockFx } from '../fx/BlockFx';

export interface InteractionHost {
  getBlock: BlockQuery;
  /** Whether editing is allowed right now (e.g. not in parkour). */
  canEdit(): boolean;
  /** Requests a block change (applied locally and/or sent to the server). */
  edit(x: number, y: number, z: number, id: number): void;
  /** True if any player's body overlaps this block cell. */
  isOccupied(x: number, y: number, z: number): boolean;
}

const PLACE_REPEAT = 0.28;
const BREAK_COOLDOWN = 0.12;

export class BlockInteraction {
  target: VoxelHit | null = null;
  private progress = 0;
  private progressKey = '';
  private placeTimer = 0;
  private breakCooldown = 0;
  private digSoundTimer = 0;
  /** Swing animation trigger for the held item (0..1). */
  swing = 0;

  constructor(
    private readonly host: InteractionHost,
    private readonly fx: BlockFx,
  ) {}

  update(dt: number, frame: InputFrame, eye: THREE.Vector3, dir: THREE.Vector3, selected: Block, feet: { x: number; y: number; z: number }): void {
    this.swing = Math.max(0, this.swing - dt * 4);
    this.breakCooldown -= dt;
    const get = this.host.getBlock;
    this.target = raycastVoxels(get, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, REACH);
    const t = this.target;
    if (!t || !this.host.canEdit()) {
      this.fx.hideHighlight();
      this.progress = 0;
      if (t) this.fx.showHighlight(t.x, t.y, t.z);
      return;
    }
    this.fx.showHighlight(t.x, t.y, t.z);

    // ---- breaking -------------------------------------------------------------
    const def = blockDef(t.block);
    const key = `${t.x},${t.y},${t.z}`;
    if (frame.held.has('primary') && def.breakable && this.breakCooldown <= 0) {
      if (key !== this.progressKey) {
        this.progressKey = key;
        this.progress = 0;
      }
      this.progress += dt / Math.max(0.05, def.hardness);
      this.swing = Math.max(this.swing, 0.6);
      this.digSoundTimer -= dt;
      if (this.digSoundTimer <= 0) {
        audio.play('dig', { pitch: 0.9 + Math.random() * 0.2 });
        this.digSoundTimer = 0.22;
      }
      if (this.progress >= 1) {
        this.host.edit(t.x, t.y, t.z, Block.Air);
        this.fx.burst(t.x, t.y, t.z, t.block);
        audio.play('break', { pitch: 0.9 + Math.random() * 0.2 });
        this.progress = 0;
        this.progressKey = '';
        this.breakCooldown = BREAK_COOLDOWN;
        this.fx.setCrack(0, 0, 0, 0);
      } else {
        this.fx.setCrack(t.x, t.y, t.z, this.progress);
      }
    } else {
      this.progress = 0;
      this.progressKey = '';
      this.fx.setCrack(0, 0, 0, 0);
    }

    // ---- placing -----------------------------------------------------------------
    this.placeTimer -= dt;
    const wantPlace = frame.pressed.has('secondary') || (frame.held.has('secondary') && this.placeTimer <= 0);
    if (wantPlace) {
      this.placeTimer = PLACE_REPEAT;
      const px = t.x + t.nx;
      const py = t.y + t.ny;
      const pz = t.z + t.nz;
      if (this.canPlaceAt(px, py, pz, feet)) {
        this.host.edit(px, py, pz, selected);
        audio.play('place', { pitch: 0.95 + Math.random() * 0.1 });
        this.swing = 1;
      }
    }
  }

  private canPlaceAt(x: number, y: number, z: number, feet: { x: number; y: number; z: number }): boolean {
    if (y < 1 || y >= CHUNK_HEIGHT) return false;
    const existing = this.host.getBlock(x, y, z);
    if (existing !== Block.Air && !IS_LIQUID[existing]) return false;
    // Don't place inside the local player.
    const half = PLAYER_WIDTH / 2;
    const overlaps =
      x + 1 > feet.x - half && x < feet.x + half && z + 1 > feet.z - half && z < feet.z + half && y + 1 > feet.y && y < feet.y + PLAYER_HEIGHT;
    if (overlaps) return false;
    return !this.host.isOccupied(x, y, z);
  }
}
