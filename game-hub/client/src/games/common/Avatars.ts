/**
 * Blocky player avatars for both games, drawn with a handful of InstancedMesh
 * objects (heads, eyes, bodies, arms, legs), so 16 players cost 5 draw calls
 * instead of ~100. Nametags are small canvas sprites.
 *
 * Held items (weapons, tools) are generic: the game names a model by a number
 * key and supplies the geometry; each key in use costs one more draw call.
 */
import * as THREE from 'three';

export interface AvatarPose {
  id: string;
  /** Feet position. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  color: number;
  /** Horizontal speed, drives the walk cycle. */
  speed: number;
  crouch: boolean;
  name?: string;
  /** 0..1, fades dead/disconnected players. */
  alpha?: number;
  /** Optional arm pose: point both arms forward (holding a weapon). */
  aiming?: boolean;
  /** Key of the held item model (arena: WeaponId); undefined = empty hands. */
  held?: number;
  /** Arena slide pose. */
  slide?: boolean;
}

export interface AvatarOptions {
  /**
   * Third-person geometry for a held-item key: grip at the origin, item toward -Z, vertex colours,
   * optional `userData.muzzle: THREE.Vector3` in item space. Called once per key, lazily. Null = nothing drawn.
   */
  heldModel?: (key: number) => THREE.BufferGeometry | null;
}

const SKIN = [0xf1c7a5, 0xd9a07a, 0xa86b45, 0x6e4529];

/** Where the hands hold an item, in avatar space (feet origin, facing -Z). */
const HELD_X = 0.2;
const HELD_Y = 1.17;
const HELD_Z = -0.28;

interface Part {
  mesh: THREE.InstancedMesh;
  perAvatar: number;
}

/** The plain box used when the game supplies no held models. */
function defaultHeldModel(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.09, 0.12, 0.62).translate(0, 0, -0.31);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(0x2b2f3a);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.userData.muzzle = new THREE.Vector3(0, 0, -0.62);
  return geo;
}

interface HeldPool {
  /** Null when the model builder returned nothing for this key. */
  mesh: THREE.InstancedMesh | null;
  muzzle: THREE.Vector3 | null;
  count: number;
}

export class AvatarRenderer {
  readonly group = new THREE.Group();
  private readonly heads: Part;
  private readonly eyes: Part;
  private readonly bodies: Part;
  private readonly arms: Part;
  private readonly legs: Part;
  private readonly heldMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly held = new Map<number, HeldPool>();
  /** Per avatar id: held key and item transform of the last update (for muzzleWorld). */
  private readonly heldAt = new Map<string, { key: number; matrix: THREE.Matrix4 }>();
  private readonly walk = new Map<string, number>();
  private readonly tags = new Map<string, { sprite: THREE.Sprite; text: string }>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly base = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();

  constructor(
    private readonly max = 16,
    private readonly opts: AvatarOptions = {},
  ) {
    const mat = () => new THREE.MeshLambertMaterial({ color: 0xffffff });
    const part = (geo: THREE.BufferGeometry, perAvatar: number): Part => {
      const mesh = new THREE.InstancedMesh(geo, mat(), max * perAvatar);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { mesh, perAvatar };
    };
    // Geometry origins sit at the joint each part rotates around.
    this.heads = part(new THREE.BoxGeometry(0.44, 0.44, 0.44).translate(0, 0.22, 0), 1);
    this.eyes = part(new THREE.BoxGeometry(0.08, 0.1, 0.02).translate(0, 0, 0), 2);
    this.bodies = part(new THREE.BoxGeometry(0.48, 0.66, 0.26).translate(0, 0.33, 0), 1);
    this.arms = part(new THREE.BoxGeometry(0.18, 0.64, 0.2).translate(0, -0.28, 0), 2);
    this.legs = part(new THREE.BoxGeometry(0.22, 0.72, 0.24).translate(0, -0.36, 0), 2);
  }

  private get parts(): Part[] {
    return [this.heads, this.eyes, this.bodies, this.arms, this.legs];
  }

  /** The instanced pool for a held-item key, created on first use. */
  private heldPool(key: number): HeldPool {
    let pool = this.held.get(key);
    if (!pool) {
      const geo = this.opts.heldModel ? this.opts.heldModel(key) : defaultHeldModel();
      let mesh: THREE.InstancedMesh | null = null;
      if (geo) {
        mesh = new THREE.InstancedMesh(geo, this.heldMaterial, this.max);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
      }
      const muzzle = geo?.userData.muzzle;
      pool = { mesh, muzzle: muzzle instanceof THREE.Vector3 ? muzzle.clone() : null, count: 0 };
      this.held.set(key, pool);
    }
    return pool;
  }

  /** World position of the held item's muzzle for this avatar (last update), or null. */
  muzzleWorld(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const at = this.heldAt.get(id);
    const muzzle = at ? this.held.get(at.key)?.muzzle : null;
    if (!at || !muzzle) return null;
    return out.copy(muzzle).applyMatrix4(at.matrix);
  }

  /** Updates every avatar for this frame. */
  update(poses: AvatarPose[], dt: number, camera: THREE.Camera, showNames = true): void {
    const n = Math.min(poses.length, this.max);
    const seen = new Set<string>();
    for (const pool of this.held.values()) pool.count = 0;
    for (let i = 0; i < n; i++) {
      const a = poses[i];
      seen.add(a.id);
      let phase = this.walk.get(a.id) ?? 0;
      phase += dt * a.speed * 2.4;
      this.walk.set(a.id, phase);
      const swing = Math.sin(phase) * Math.min(1, a.speed / 3) * 0.7;
      const crouch = a.crouch ? 0.18 : 0;
      const lean = a.crouch ? 0.35 : 0;

      // Root transform: feet position + yaw (avatars face -Z like the camera).
      this.base.compose(this.p.set(a.x, a.y, a.z), this.q.setFromEuler(this.e.set(0, a.yaw, 0)), this.s.set(1, 1, 1));

      const skin = SKIN[hashId(a.id) % SKIN.length];
      // Legs
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -0.12 : 0.12;
        this.setPart(this.legs, i * 2 + k, side, 0.72 - crouch, 0, (k === 0 ? swing : -swing) - lean * 0.2, 0, this.c.setHex(a.color).multiplyScalar(0.45));
      }
      // Body
      this.setPart(this.bodies, i, 0, 0.72 - crouch, 0, -lean, 0, this.c.setHex(a.color));
      // Arms
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? -0.33 : 0.33;
        const armPitch = a.aiming ? Math.PI / 2 + a.pitch * 0.8 : (k === 0 ? -swing : swing) * 0.9;
        this.setPart(this.arms, i * 2 + k, side, 1.34 - crouch - lean * 0.15, -lean * 0.2, armPitch, 0, this.c.setHex(a.color).multiplyScalar(0.85));
      }
      // Head (pitch follows the view)
      const headY = 1.38 - crouch;
      this.setPart(this.heads, i, 0, headY, -lean * 0.25, a.pitch * 0.8, 0, this.c.setHex(skin));
      for (let k = 0; k < 2; k++) {
        // Eyes sit on the front (-Z) face of the head, rotated with it.
        this.local.compose(this.p.set(0, headY, -lean * 0.25), this.q.setFromEuler(this.e.set(a.pitch * 0.8, 0, 0)), this.s.set(1, 1, 1));
        this.m.makeTranslation(k === 0 ? -0.1 : 0.1, 0.26, -0.225);
        this.local.multiply(this.m);
        this.m.multiplyMatrices(this.base, this.local);
        this.eyes.mesh.setMatrixAt(i * 2 + k, this.m);
        this.eyes.mesh.setColorAt(i * 2 + k, this.c.setHex(0x1a1f33));
      }

      // Held item in the right hand, following the view pitch.
      if (a.held !== undefined) {
        const pool = this.heldPool(a.held);
        this.local.compose(this.p.set(HELD_X, HELD_Y - crouch, HELD_Z), this.q.setFromEuler(this.e.set(a.pitch * 0.8, 0, 0)), this.s.set(1, 1, 1));
        this.m.multiplyMatrices(this.base, this.local);
        if (pool.mesh) pool.mesh.setMatrixAt(pool.count++, this.m);
        const at = this.heldAt.get(a.id);
        if (at) {
          at.key = a.held;
          at.matrix.copy(this.m);
        } else this.heldAt.set(a.id, { key: a.held, matrix: this.m.clone() });
      } else this.heldAt.delete(a.id);

      if (showNames && a.name) this.updateTag(a, camera);
    }
    for (const part of this.parts) {
      part.mesh.count = n * part.perAvatar;
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    // Unused item models cost no draw call.
    for (const pool of this.held.values()) {
      if (!pool.mesh) continue;
      pool.mesh.count = pool.count;
      pool.mesh.visible = pool.count > 0;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
    for (const id of this.heldAt.keys()) if (!seen.has(id)) this.heldAt.delete(id);
    for (const [id, tag] of this.tags) {
      if (!seen.has(id) || !showNames || !poses.some((p) => p.id === id && p.name)) {
        tag.sprite.visible = false;
        if (!seen.has(id)) {
          this.group.remove(tag.sprite);
          tag.sprite.material.map?.dispose();
          tag.sprite.material.dispose();
          this.tags.delete(id);
          this.walk.delete(id);
        }
      }
    }
  }

  /** Applies daylight to the avatar materials (voxel day/night). */
  setBrightness(k: number): void {
    for (const part of this.parts) {
      (part.mesh.material as THREE.MeshLambertMaterial).color.setScalar(k);
    }
    this.heldMaterial.color.setScalar(k);
  }

  dispose(): void {
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      (part.mesh.material as THREE.Material).dispose();
      part.mesh.dispose();
    }
    for (const pool of this.held.values()) {
      if (!pool.mesh) continue;
      this.group.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      pool.mesh.dispose();
    }
    this.held.clear();
    this.heldAt.clear();
    this.heldMaterial.dispose();
    for (const t of this.tags.values()) {
      t.sprite.material.map?.dispose();
      t.sprite.material.dispose();
    }
    this.tags.clear();
  }

  private setPart(part: Part, index: number, x: number, y: number, z: number, pitch: number, roll: number, color: THREE.Color): void {
    this.local.compose(this.p.set(x, y, z), this.q.setFromEuler(this.e.set(pitch, 0, roll)), this.s.set(1, 1, 1));
    this.m.multiplyMatrices(this.base, this.local);
    part.mesh.setMatrixAt(index, this.m);
    part.mesh.setColorAt(index, color);
  }

  private updateTag(a: AvatarPose, camera: THREE.Camera): void {
    let tag = this.tags.get(a.id);
    if (!tag || tag.text !== a.name) {
      if (tag) {
        this.group.remove(tag.sprite);
        tag.sprite.material.map?.dispose();
        tag.sprite.material.dispose();
      }
      tag = { sprite: makeNameSprite(a.name!, a.color), text: a.name! };
      this.tags.set(a.id, tag);
      this.group.add(tag.sprite);
    }
    const d = camera.position.distanceTo(this.p.set(a.x, a.y, a.z));
    tag.sprite.visible = d < 48;
    tag.sprite.position.set(a.x, a.y + 2.15 - (a.crouch ? 0.2 : 0), a.z);
    // Keep nametags readable at distance: grow slowly with range.
    const k = 0.9 + Math.min(d, 40) * 0.025;
    tag.sprite.scale.set(tag.sprite.userData.aspect * 0.32 * k, 0.32 * k, 1);
    (tag.sprite.material as THREE.SpriteMaterial).opacity = a.alpha ?? 1;
  }
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function makeNameSprite(name: string, color: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '700 40px ui-rounded, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(name).width) + 44;
  canvas.width = w;
  canvas.height = 64;
  ctx.font = font;
  ctx.fillStyle = 'rgba(10, 14, 28, 0.6)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 64, 18);
  ctx.fill();
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(14, 22, 10, 20);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true }));
  sprite.userData.aspect = w / 64;
  sprite.renderOrder = 10;
  return sprite;
}
