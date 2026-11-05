#!/usr/bin/env node
// Writes .gz and .br copies next to text assets in dist/. GitLab Pages serves a precompressed copy when the browser
// accepts it, so the editor bundle and the PDF.js worker download several times smaller.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = path.resolve(process.argv[2] ?? 'dist');
const TEXT = /\.(js|mjs|css|html|svg|json|txt|map|ttf|dic|aff)$/i;
let before = 0, after = 0;
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});
for (const file of walk(root).filter(f => TEXT.test(f))) {
  const data = readFileSync(file);
  if (data.length < 1024) continue;
  const br = brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
  writeFileSync(`${file}.br`, br);
  before += data.length; after += br.length;
}
console.log(`Precompressed ${root}: ${(before / 1e6).toFixed(2)} MB → ${(after / 1e6).toFixed(2)} MB (brotli)`);
