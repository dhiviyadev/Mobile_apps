/**
 * Vertex-coloured material for item models (held items, drops) lit exactly
 * like voxel terrain: the `light` attribute carries (face shade, sky light,
 * block light, emissive) and the shared voxel uniforms bring daylight and fog.
 */
import * as THREE from 'three';
import type { VoxelUniforms } from '../world/materials';

const VERT = /* glsl */ `
  attribute vec4 light;
  attribute vec3 color;
  uniform float uDaylight;
  uniform float uFlash;
  varying vec3 vColor;
  varying float vFogDist;
  float brightness(float level) {
    return pow(0.8, (1.0 - level) * 15.0);
  }
  void main() {
    float sky = brightness(light.y) * mix(0.16, 1.0, uDaylight);
    vec3 lamp = brightness(light.z) * vec3(1.0, 0.85, 0.62);
    vec3 lit = max(max(vec3(sky), lamp), vec3(0.06));
    vColor = mix(color * light.x * mix(lit, vec3(1.0), light.w), vec3(1.0, 0.25, 0.2), uFlash);
    #ifdef USE_INSTANCING
      vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    #else
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
    #endif
    vFogDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vFogDist;
  void main() {
    gl_FragColor = vec4(mix(vColor, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist)), uOpacity);
  }
`;

/** One material per use (its own uFlash / uOpacity), sharing the voxel uniforms. */
export function createItemMaterial(u: VoxelUniforms, opts: { transparent?: boolean } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDaylight: u.uDaylight,
      uFogColor: u.uFogColor,
      uFogNear: u.uFogNear,
      uFogFar: u.uFogFar,
      uFlash: { value: 0 },
      uOpacity: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: opts.transparent ?? false,
  });
}
