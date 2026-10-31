/**
 * A single textured block mesh compatible with the voxel shaders (held item,
 * previews): a cube, the block's box (slabs, chests, torches), or a flat
 * double-sided sprite for plants, ladders and lily pads.
 */
import * as THREE from 'three';
import { ATLAS_COLS, blockDef, BlockShape, SHAPE, SHAPE_BOUNDS } from '@hub/shared';
import { boxFaces } from '@hub/shared/voxel/mesher';

const FACE_SHADE = [0.82, 0.82, 1, 0.55, 0.68, 0.68];

export function createBlockGeometry(block: number, size = 1): THREE.BufferGeometry {
  const def = blockDef(block);
  const shape = SHAPE[block];
  const pos: number[] = [];
  const uv: number[] = [];
  const tiles: number[] = [];
  // Shade, sky, block, emissive: lit like an open-air block (the game rewrites sky and block for the held block).
  const light: number[] = [];
  const index: number[] = [];
  const quad = (c: number[], u: number[], tile: number, shade: number) => {
    const base = pos.length / 3;
    for (let k = 0; k < 4; k++) {
      // Centred on the origin, scaled to `size`.
      pos.push((c[k * 3] - 0.5) * size, (c[k * 3 + 1] - 0.5) * size, (c[k * 3 + 2] - 0.5) * size);
      uv.push(u[k * 2], u[k * 2 + 1]);
      tiles.push(tile % ATLAS_COLS, Math.floor(tile / ATLAS_COLS));
      light.push(Math.round(shade * 255), 255, 0, def.emissive ? 255 : 0);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  if (shape === BlockShape.Cube || shape === BlockShape.Box) {
    const b = block * 6;
    const bounds = shape === BlockShape.Box ? [...SHAPE_BOUNDS.subarray(b, b + 6)] : [0, 0, 0, 1, 1, 1];
    // Boxes sit on the bottom of the unit cell, so centre them vertically too.
    const dy = shape === BlockShape.Box ? (1 - bounds[4] - bounds[1]) / 2 : 0;
    boxFaces(0, dy, 0, bounds[0], bounds[1], bounds[2], bounds[3], bounds[4], bounds[5], () => true, (face, c, u) =>
      quad(c, u, face === 2 ? def.tiles[0] : face === 3 ? def.tiles[1] : def.tiles[2], FACE_SHADE[face]),
    );
  } else {
    // Sprites: one upright plane through the cell, both sides, full tile.
    const tile = shape === BlockShape.Pad ? def.tiles[0] : def.tiles[2];
    const front = [0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0.5];
    const st = [0, 0, 1, 0, 1, 1, 0, 1];
    quad(front, st, tile, 1);
    quad([1, 0, 0.5, 0, 0, 0.5, 0, 1, 0.5, 1, 1, 0.5], [1, 0, 0, 0, 0, 1, 1, 1], tile, 0.9);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('tile', new THREE.BufferAttribute(new Uint8Array(tiles), 2));
  geo.setAttribute('light', new THREE.BufferAttribute(new Uint8Array(light), 4, true));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}
