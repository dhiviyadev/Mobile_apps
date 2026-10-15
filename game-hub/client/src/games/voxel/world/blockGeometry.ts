/** A single textured block mesh compatible with the voxel shaders (held item, previews). */
import * as THREE from 'three';
import { blockDef } from '@hub/shared';

const FACE_SHADE = [0.82, 0.82, 1, 0.55, 0.68, 0.68];

export function createBlockGeometry(block: number, size = 1): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size, size, size);
  const def = blockDef(block);
  const n = geo.attributes.position.count; // 24: 4 per face, order +x -x +y -y +z -z
  const tiles = new Uint8Array(n * 2);
  // Shade, sky, block, emissive: lit like an open-air block (the game rewrites sky and block for the held block).
  const light = new Uint8Array(n * 4);
  for (let face = 0; face < 6; face++) {
    const tile = face === 2 ? def.tiles[0] : face === 3 ? def.tiles[1] : def.tiles[2];
    for (let v = 0; v < 4; v++) {
      const i = face * 4 + v;
      tiles[i * 2] = tile % 8;
      tiles[i * 2 + 1] = Math.floor(tile / 8);
      light[i * 4] = Math.round(FACE_SHADE[face] * 255);
      light[i * 4 + 1] = 255;
      light[i * 4 + 2] = 0;
      light[i * 4 + 3] = def.emissive ? 255 : 0;
    }
  }
  geo.setAttribute('tile', new THREE.BufferAttribute(tiles, 2));
  geo.setAttribute('light', new THREE.BufferAttribute(light, 4, true));
  return geo;
}
