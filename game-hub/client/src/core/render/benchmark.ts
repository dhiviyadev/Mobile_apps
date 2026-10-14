/**
 * Quick first-run GPU benchmark (≤ 0.15 s) used when the quality setting is
 * "Auto". Draws a fixed fill-rate + ALU workload into an offscreen WebGL2
 * canvas, times it (forcing completion with a 1-pixel readback), and combines the result with a few
 * device hints (cores, memory, GPU name) to pick Low / Medium / High.
 */
import type { QualityPreset } from '../settings';

export interface BenchmarkResult {
  preset: QualityPreset;
  msPerFrame: number;
  gpu: string;
}

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// A deliberately non-trivial fragment shader: a little noise-ish math per pixel.
const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
uniform float t;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  vec2 q = uv * 6.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    q = vec2(sin(q.y * 1.3 + t + fi), cos(q.x * 1.7 - t * 0.5 + fi)) * 1.1 + q * 0.2;
    c += vec3(abs(q.x), abs(q.y), abs(q.x * q.y)) * 0.03;
  }
  o = vec4(fract(c), 1.0);
}`;

function gpuName(gl: WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return String(name ?? 'unknown');
}

/** Runs the benchmark; never throws (falls back to "medium"). */
export function runBenchmark(): BenchmarkResult {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (!gl) return { preset: 'low', msPerFrame: Infinity, gpu: 'no webgl2' };
    const gpu = gpuName(gl);
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { preset: 'medium', msPerFrame: NaN, gpu };
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tLoc = gl.getUniformLocation(prog, 't');
    gl.viewport(0, 0, canvas.width, canvas.height);

    const frame = (i: number) => {
      gl.uniform1f(tLoc, i * 0.1);
      // Two layers of overdraw, like a busy game scene.
      for (let k = 0; k < 2; k++) gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    // readPixels forces the GPU to finish (gl.finish() is a no-op on some ANGLE backends).
    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const done = (ms: number) => {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return { preset: classify(ms, gpu), msPerFrame: ms, gpu };
    };
    // Warm up (shader compile, driver caches). A very slow first frame already tells us enough.
    const w0 = performance.now();
    frame(0);
    sync();
    if (performance.now() - w0 > 120) return done(99);
    // Measure, never spending more than ~150 ms in total.
    let frames = 0;
    const start = performance.now();
    while (frames < 8 && performance.now() - start < 150) {
      frame(++frames);
      sync();
    }
    return done((performance.now() - start) / Math.max(1, frames));
  } catch {
    return { preset: 'medium', msPerFrame: NaN, gpu: 'error' };
  }
}

export function classify(ms: number, gpu: string): QualityPreset {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const g = gpu.toLowerCase();
  // Software rendering or known entry-level mobile GPUs: always Low.
  if (/swiftshader|llvmpipe|software|mali-g(31|51|52|57)|mali-t|adreno \(tm\) (3|4|50)|powervr ge/.test(g)) return 'low';
  if (ms > 8 || memory <= 2 || cores <= 2) return 'low';
  if (ms < 2 && cores >= 6 && memory >= 4) return 'high';
  return 'medium';
}
