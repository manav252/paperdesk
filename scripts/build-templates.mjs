#!/usr/bin/env node
// Regenerates the generated parts of templates/: the placeholder figures (drawn from templates/_figures/*.tex)
// and each template's thumbnail.png (page 1 of its compiled PDF). Needs Docker and the compiler image.
// Usage: npm run templates:build [-- --figures | --thumbnails] [template-id ...]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('templates');
const IMAGE = process.env.LATEX_DOCKER_IMAGE ?? 'paperdesk-texlive:latest';
const args = process.argv.slice(2);
const only = args.filter(a => !a.startsWith('--'));
const want = kind => !args.some(a => a.startsWith('--')) || args.includes(`--${kind}`);
const ENGINE_FLAG = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' };

function inContainer(dir, argv) {
  const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  execFileSync('docker', ['run', '--rm', '--network=none', ...user, '-e', 'HOME=/tmp', '-e', 'TEXMFVAR=/tmp/texmf-var', '-v', `${dir}:/work`, '-w', '/work', IMAGE, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
function compile(dir, main, engine = 'pdflatex') {
  try { inContainer(dir, ['latexmk', ENGINE_FLAG[engine], '-interaction=nonstopmode', '-halt-on-error', '-norc', main]); }
  catch (e) { throw new Error(`${main} did not compile:\n${String(e.stdout ?? '').split('\n').filter(l => /^!|Error|:\d+:/.test(l)).slice(0, 8).join('\n')}`); }
}
function toPng(dir, pdf, png, dpi, device = 'png16m') {
  inContainer(dir, ['gs', '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', `-sDEVICE=${device}`, `-r${dpi}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${png}`, pdf]);
}
const work = mkdtempSync(path.join(process.env.TEMPLATE_BUILD_TMP ?? tmpdir(), 'paperdesk-templates-'));
const templates = readdirSync(ROOT).filter(n => !n.startsWith('_') && statSync(path.join(ROOT, n)).isDirectory());

try {
  if (want('figures')) {
    const map = JSON.parse(readFileSync(path.join(ROOT, '_figures', 'figures.json'), 'utf8'));
    const dir = path.join(work, 'figures');
    cpSync(path.join(ROOT, '_figures'), dir, { recursive: true });
    for (const [name, targets] of Object.entries(map)) {
      const used = targets.filter(t => !only.length || only.includes(t.split('/')[0]));
      if (!used.length) continue;
      compile(dir, `${name}.tex`);
      toPng(dir, `${name}.pdf`, `${name}.png`, 160);
      for (const target of used) {
        mkdirSync(path.dirname(path.join(ROOT, target)), { recursive: true });
        cpSync(path.join(dir, `${name}.png`), path.join(ROOT, target));
      }
      console.log(`figure  ${name} -> ${used.join(', ')}`);
    }
  }
  if (want('thumbnails')) {
    for (const id of templates.filter(t => !only.length || only.includes(t))) {
      const meta = JSON.parse(readFileSync(path.join(ROOT, id, 'metadata.json'), 'utf8'));
      const dir = path.join(work, id);
      cpSync(path.join(ROOT, id), dir, { recursive: true });
      const main = meta.mainFile ?? 'main.tex';
      compile(dir, main, meta.engine ?? 'pdflatex');
      toPng(dir, main.replace(/\.tex$/, '.pdf'), 'thumbnail.png', 56, 'png256');
      cpSync(path.join(dir, 'thumbnail.png'), path.join(ROOT, id, 'thumbnail.png'));
      console.log(`preview ${id}`);
    }
  }
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  if (existsSync(work)) rmSync(work, { recursive: true, force: true });
}
