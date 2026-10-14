/**
 * Custom shaders for voxel terrain. Lighting (face shade + AO) is baked into
 * vertex attributes by the mesher, so the GPU work per pixel is one texture
 * fetch and a fog mix: cheap enough for low-end tablets.
 *
 * Greedy-merged quads span several blocks, so UVs are in block units and the
 * fragment shader wraps them into the right atlas tile with fract().
 */
import * as THREE from 'three';
import { ATLAS_TILES } from './atlas';

export interface VoxelUniforms {
  [name: string]: THREE.IUniform;
  uAtlas: { value: THREE.Texture };
  uDaylight: { value: number };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uTime: { value: number };
}

export function createVoxelUniforms(atlas: THREE.Texture): VoxelUniforms {
  return {
    uAtlas: { value: atlas },
    uDaylight: { value: 1 },
    uFogColor: { value: new THREE.Color(0xbfe3ff) },
    uFogNear: { value: 40 },
    uFogFar: { value: 70 },
    uTime: { value: 0 },
  };
}

const VERT = /* glsl */ `
  attribute vec2 tile;
  attribute vec2 light;
  uniform float uDaylight;
  varying vec2 vUv;
  varying vec2 vTile;
  varying float vLight;
  varying float vFogDist;
  void main() {
    vUv = uv;
    vTile = tile;
    float sky = mix(0.2, 1.0, uDaylight);
    vLight = light.x * max(sky, light.y);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_COMMON = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uTime;
  varying vec2 vUv;
  varying vec2 vTile;
  varying float vLight;
  varying float vFogDist;
  vec4 atlasSample(vec2 uv) {
    vec2 f = clamp(fract(uv), 0.001, 0.999);
    return texture2D(uAtlas, (vTile + vec2(f.x, 1.0 - f.y)) / ${ATLAS_TILES.toFixed(1)});
  }
  vec3 applyFog(vec3 c) {
    return mix(c, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist));
  }
`;

export function createOpaqueMaterial(u: VoxelUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      ${FRAG_COMMON}
      void main() {
        vec4 c = atlasSample(vUv);
        if (c.a < 0.5) discard;
        gl_FragColor = vec4(applyFog(c.rgb * vLight), 1.0);
      }
    `,
  });
}

export function createLiquidMaterial(u: VoxelUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      ${FRAG_COMMON}
      void main() {
        vec4 c = atlasSample(vUv + vec2(uTime * 0.04, uTime * 0.025));
        float shimmer = 0.06 * sin(uTime * 1.7 + vUv.x * 2.1 + vUv.y * 1.3);
        gl_FragColor = vec4(applyFog(c.rgb * (vLight + shimmer)), 0.72);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Crack overlay drawn over the block being broken. */
export function createCrackMaterial(u: VoxelUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: VERT,
    fragmentShader: /* glsl */ `
      ${FRAG_COMMON}
      void main() {
        vec4 c = atlasSample(vUv);
        if (c.a < 0.05) discard;
        gl_FragColor = vec4(c.rgb, c.a * 0.85);
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}
