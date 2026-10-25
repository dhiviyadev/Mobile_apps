/**
 * Third-person weapon models for the avatars' held-item API (AvatarOptions.heldModel): the low-detail
 * build of each weapon spec (no detail parts, fewer cylinder sides; ≤ 260 triangles), one merged
 * geometry with vertex colours and `userData.muzzle` in item space.
 *
 * The avatars put the item origin at the right hand (0.2, 1.17, −0.28 in avatar space) and pitch it
 * with the view. The blocky avatars hold both arms straight forward, so the model is shifted to sit
 * centred between the arms at chest height, stock at the shoulder, and drawn a little larger than
 * life so the silhouette reads at a distance.
 */
import * as THREE from 'three';
import { isWeaponId } from '@hub/shared';
import { buildWeapon } from './weaponKit';
import { WEAPON_SPECS } from './weaponSpecs';

const SCALE = 1.12;
/** Item-space offset of the grip from the avatar's hand point. */
const OFFSET = new THREE.Vector3(-0.2, 0.07, -0.2);

export function arenaHeldModel(key: number): THREE.BufferGeometry | null {
  if (!isWeaponId(key)) return null;
  const built = buildWeapon(WEAPON_SPECS[key], 'tp');
  const geo = built.body;
  geo.scale(SCALE, SCALE, SCALE).translate(OFFSET.x, OFFSET.y, OFFSET.z);
  geo.computeBoundingSphere();
  geo.userData.muzzle = new THREE.Vector3(...built.anchors.muzzle).multiplyScalar(SCALE).add(OFFSET);
  return geo;
}
