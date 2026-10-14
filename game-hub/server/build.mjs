// Bundles the server (and the TypeScript sources of @hub/shared) into dist/index.js.
// Third-party npm dependencies stay external and are installed in the Docker image.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@hub/'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  external,
  logLevel: 'info',
});
