#!/usr/bin/env node
// Downloads the fonts built into Typst (the typst-assets release that matches the pinned Typst version) into
// public/typst-fonts/, with their licences, and writes fonts.json: each font's metadata, so the live preview can
// register every font up front and download a file only when a document uses it.
// Usage: node scripts/typst-fonts.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const VERSION = '0.14.2';
const FONTS = [
  'DejaVuSansMono.ttf',
  'DejaVuSansMono-Bold.ttf',
  'DejaVuSansMono-Oblique.ttf',
  'DejaVuSansMono-BoldOblique.ttf',
  'LibertinusSerif-Regular.otf',
  'LibertinusSerif-Italic.otf',
  'LibertinusSerif-Bold.otf',
  'LibertinusSerif-BoldItalic.otf',
  'LibertinusSerif-Semibold.otf',
  'LibertinusSerif-SemiboldItalic.otf',
  'NewCM10-Regular.otf',
  'NewCM10-Italic.otf',
  'NewCM10-Bold.otf',
  'NewCM10-BoldItalic.otf',
  'NewCMMath-Regular.otf',
  'NewCMMath-Book.otf',
  'NewCMMath-Bold.otf',
];
const RAW = `https://raw.githubusercontent.com/typst/typst-assets/v${VERSION}`;
const out = path.resolve('public/typst-fonts');
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('@myriaddreamin/typst-ts-web-compiler/package.json'));
const compiler = await import(path.join(pkg, 'pkg/typst_ts_web_compiler.mjs'));
compiler.initSync({ module: readFileSync(path.join(pkg, 'pkg/typst_ts_web_compiler_bg.wasm')) });

const get = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const manifest = [];
for (const file of FONTS) {
  const data = await get(`${RAW}/files/fonts/${file}`);
  writeFileSync(path.join(out, file), data);
  // Everything get_font_info returns is needed again by add_lazy_font.
  const { info, conditions } = compiler.get_font_info(new Uint8Array(data));
  manifest.push({ file, info, conditions });
  console.log(`${file}  ${(data.length / 1024).toFixed(0)} KB`);
}
for (const file of ['LICENSE', 'NOTICE']) writeFileSync(path.join(out, file), await get(`${RAW}/${file}`));
writeFileSync(path.join(out, 'fonts.json'), JSON.stringify({ version: VERSION, fonts: manifest }));
console.log(`Wrote ${FONTS.length} fonts and fonts.json to ${path.relative(process.cwd(), out)}`);
