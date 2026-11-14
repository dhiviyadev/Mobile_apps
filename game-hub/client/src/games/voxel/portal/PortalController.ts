/**
 * Lattice Rings in the running game (sandbox and survival, package D): lighting
 * a ring with a Dusk Lens, the swirl and hum while you stand in a lit veil, the
 * glowing outline of missing stones, the realm banner on arrival, one-time
 * survival hints, and which realm the sky, fog and music are in. The rules live
 * in the shared PortalCore: offline in the browser (LocalPortal), online on the
 * server (PortalHost).
 */
import * as THREE from 'three';
import { Block, hasDimension, Item, PORTAL, type PortalEvent, Realm, realmAt, REALM_NAMES, type VoxelHit } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import { h } from '../../../core/ui/dom';
import { toast } from '../../../core/ui/overlays';
import type { VoxelModule } from '../modules';
import type { VoxelGame } from '../VoxelGame';
import type { PortalBackend } from './backends';

const HINT_PREFIX = 'cobalt-hub.voxel.hint.';

function hintSeen(key: string): boolean {
  try {
    return localStorage.getItem(HINT_PREFIX + key) === '1';
  } catch {
    return false;
  }
}
function markHint(key: string): void {
  try {
    localStorage.setItem(HINT_PREFIX + key, '1');
  } catch {
    /* private mode: the hint may show again */
  }
}

export class PortalController implements VoxelModule {
  private backend: PortalBackend | null = null;
  private readonly veil: HTMLElement;
  private charge: { start: number; ms: number } | null = null;
  private outline: { group: THREE.Group; until: number } | null = null;
  private realm: Realm | null = null;
  private clock = 0;
  /** Last frame's lit-veil overlap (hints, tests). */
  arrivals = 0;

  constructor(private readonly game: VoxelGame) {
    this.veil = h('div', { class: 'gloam-veil hidden', 'data-testid': 'gloam-veil', 'aria-hidden': 'true' }, h('div', { class: 'gloam-veil-swirl' }));
    game.hudContainer.append(this.veil);
  }

  attach(backend: PortalBackend): void {
    this.backend?.dispose();
    this.backend = backend;
  }

  /** The realm the player is in now. */
  get currentRealm(): Realm {
    return this.realm ?? realmAt(this.game.generator.genVersion, this.game.player.body.x);
  }

  // ---- input: a Dusk Lens used on a Lattice Stone ----------------------------------------------

  readonly interaction = {
    onSecondary: (t: VoxelHit | null, pressed: boolean): boolean => {
      if (!t || (t.block !== Block.LatticeStone && t.block !== Block.LatticeStoneLit)) return false;
      if (this.game.hotbar.heldItem(this.game.hud.selected) !== Item.DuskLens) return false;
      if (pressed) this.light(t.x, t.y, t.z);
      return true;
    },
  };

  light(x: number, y: number, z: number): void {
    this.backend?.send({ op: 'light', x, y, z });
  }

  // ---- events from the backend -----------------------------------------------------------------

  readonly onEvent = (e: PortalEvent): void => {
    switch (e.kind) {
      case 'lit':
        audio.play('gloamLight', { volume: 0.9 });
        break;
      case 'charging':
        this.charge = { start: performance.now(), ms: e.ms };
        this.veil.classList.remove('hidden');
        audio.play('gloamHum', { volume: 0.9 });
        break;
      case 'cancelled':
        this.endCharge();
        break;
      case 'arrived':
        this.endCharge();
        this.arrivals++;
        audio.play('gloamArrive', { volume: 1 });
        this.flash();
        this.game.hud.showPlace(e.name, e.realm === Realm.Gloamreach ? 'No sun here. Keep a light close.' : 'Back home', 4200);
        this.hint(e.realm);
        break;
      case 'outline':
        this.showOutline(e.missing, e.blocked, e.ms);
        break;
      case 'notice':
        toast(e.text, e.error ? 'error' : 'info', 3600);
        break;
    }
  };

  private endCharge(): void {
    this.charge = null;
    this.veil.classList.add('hidden');
    this.veil.style.setProperty('--gloam-charge', '0');
  }

  /** A quick bright flash as you come through. */
  private flash(): void {
    this.veil.classList.remove('hidden');
    this.veil.classList.add('flash');
    window.setTimeout(() => {
      this.veil.classList.remove('flash');
      if (!this.charge) this.veil.classList.add('hidden');
    }, 700);
  }

  private hint(realm: Realm): void {
    const survival = this.game.generator.mode === 'survival';
    if (realm === Realm.Gloamreach && !hintSeen('gloam-arrive')) {
      markHint('gloam-arrive');
      window.setTimeout(
        () => toast(survival ? 'The Gloamreach never gets bright: creatures stir here always. Starfall ore glows mint; an iron pickaxe breaks it.' : 'Welcome to the Gloamreach. Find a Twilit Lattice to come home.', 'info', 7000),
        2600,
      );
    } else if (realm === Realm.Overworld && !hintSeen('gloam-home')) {
      markHint('gloam-home');
      window.setTimeout(() => toast('Back in the overworld. Your ring stays lit until a stone is broken.', 'info', 5000), 2600);
    }
  }

  /** One-time hint when the first Lattice Stone is placed. */
  onStonePlaced(): void {
    if (hintSeen('lattice-stone')) return;
    markHint('lattice-stone');
    toast(hasDimension(this.game.generator.genVersion) ? 'Twelve Lattice Stones in a 5 by 5 ring with open corners, then use a Dusk Lens on a stone.' : 'This world is too old for rifts. Create a new world to find the Gloamreach.', 'info', 6500);
  }

  // ---- outline of missing stones -----------------------------------------------------------------

  private showOutline(missing: [number, number, number][], blocked: [number, number, number][], ms: number): void {
    this.clearOutline();
    const group = new THREE.Group();
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04));
    const solid = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const add = (cells: [number, number, number][], color: number) => {
      const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
      const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false });
      for (const [x, y, z] of cells) {
        const l = new THREE.LineSegments(box, edge);
        const m = new THREE.Mesh(solid, fill);
        l.position.set(x + 0.5, y + 0.5, z + 0.5);
        m.position.copy(l.position);
        l.renderOrder = m.renderOrder = 999;
        group.add(l, m);
      }
    };
    add(missing, 0xb48cff);
    add(blocked, 0xff6a6a);
    this.game.scene.add(group);
    this.outline = { group, until: performance.now() + ms };
  }

  private clearOutline(): void {
    if (!this.outline) return;
    this.game.scene.remove(this.outline.group);
    this.outline.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      (mesh.material as THREE.Material | undefined)?.dispose?.();
    });
    this.outline = null;
  }

  // ---- per frame ----------------------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    this.backend?.update(dt);
    const g = this.game;
    const realm = realmAt(g.generator.genVersion, g.player.body.x);
    if (realm !== this.realm) {
      const first = this.realm === null;
      this.realm = realm;
      g.sky.setRealm(realm === Realm.Gloamreach, first);
      if (!first || realm === Realm.Gloamreach) audio.playMusic(realm === Realm.Gloamreach ? 'gloam' : 'voxel');
    }
    if (this.charge) {
      const k = Math.min(1, (performance.now() - this.charge.start) / this.charge.ms);
      this.veil.style.setProperty('--gloam-charge', k.toFixed(3));
    }
    if (this.outline) {
      const left = this.outline.until - performance.now();
      if (left <= 0) this.clearOutline();
      else this.outline.group.visible = Math.floor(performance.now() / 380) % 4 !== 3 || left > 1500;
    }
  }

  /** Theme of the current realm's music (after a boss fight ends). */
  get baseMood(): 'voxel' | 'gloam' {
    return this.currentRealm === Realm.Gloamreach ? 'gloam' : 'voxel';
  }

  afterLocalEdit(x: number, y: number, z: number, before: number, after: number): void {
    this.backend?.afterEdit?.(x, y, z, before, after);
    if (after === Block.LatticeStone && before !== after) this.onStonePlaced();
  }

  dispose(): void {
    this.clearOutline();
    this.backend?.dispose();
    this.veil.remove();
  }
}

export { PORTAL, REALM_NAMES };
