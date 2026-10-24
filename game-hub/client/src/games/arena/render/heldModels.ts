/**
 * Third-person weapon models for the avatars' held-item API (AvatarOptions.heldModel).
 * Grip at the origin, barrel toward -Z, vertex colours, `userData.muzzle` in item space.
 * Every weapon is the same plain box until the weapon models arrive.
 */
import * as THREE from 'three';

export function arenaHeldModel(key: number): THREE.BufferGeometry | null {
  const geo = new THREE.BoxGeometry(0.09, 0.12, 0.62).translate(0, 0, -0.31);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(0x2b2f3a);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.userData.muzzle = new THREE.Vector3(0, 0, -0.62);
  return geo;
}
