import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'node:sqlite', 'sql.js'],
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(root, 'dist/main/index.js'),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/hubPreload.ts')],
    outfile: path.join(root, 'dist/preload/hubPreload.js'),
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/hudPreload.ts')],
    outfile: path.join(root, 'dist/preload/hudPreload.js'),
  }),
]);
