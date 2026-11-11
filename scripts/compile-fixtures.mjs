#!/usr/bin/env node
// End-to-end compile check: uploads each project in test/fixtures/compile through the real API,
// compiles it with every engine listed in its expect.json, and checks the PDF or the reported error.
// Needs Docker and the compiler image (npm run compiler:build). Usage: npm run test:compile [-- name ...]
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import unzipper from 'unzipper';

const ROOT = path.resolve('test/fixtures/compile');
const PORT = Number(process.env.FIXTURE_PORT ?? 3101);
const API = `${(process.env.FIXTURE_API_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '')}/api`;
const ownerHeaders = process.env.FIXTURE_OWNER_ID ? { 'X-PaperDesk-Owner': process.env.FIXTURE_OWNER_ID } : {};
const BINARY = /\.(png|jpe?g|gif|pdf|eps)$/i;
const only = process.argv.slice(2);

function readTree(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    if (r === 'expect.json') continue;
    if (statSync(path.join(dir, r)).isDirectory()) out.push({ name: r + '/', content: '' }, ...readTree(dir, r));
    else {
      const buf = readFileSync(path.join(dir, r));
      let text = null;
      if (!BINARY.test(r)) try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8: send bytes */ }
      out.push(text === null ? { name: r, content: buf.toString('base64'), encoding: 'base64' } : { name: r, content: text });
    }
  }
  return out;
}

const json = async (url, init) => {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...ownerHeaders } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};

const data = mkdtempSync(path.join(tmpdir(), 'paperdesk-fixtures-'));
const server = process.env.FIXTURE_API_URL ? null : spawn('npx', ['tsx', 'server.ts'], { env: { ...process.env, PORT: String(PORT), PAPERDESK_DATA: data }, stdio: ['ignore', 'pipe', 'inherit'] });
const cleanup = () => { server?.kill(); rmSync(data, { recursive: true, force: true }); };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let failures = 0;
try {
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    health = await fetch(`${API}/health`).then(r => r.json()).catch(() => null);
    if (!health) await new Promise(r => setTimeout(r, 500));
  }
  if (!health) throw new Error('API did not start');
  if (health.compilerMode === 'native') {
    if (!health.compilerReady) throw new Error('Native TeX toolchain is not ready.');
  } else {
    if (!health.docker) throw new Error('Docker is not running');
    if (!health.image) throw new Error(`Compiler image ${health.compilerImage} is missing; run npm run compiler:build`);
  }

  const fixtures = readdirSync(ROOT).filter(n => statSync(path.join(ROOT, n)).isDirectory() && (!only.length || only.includes(n)));
  console.log(`Compiling ${fixtures.length} fixture project(s)…\n`);
  for (const name of fixtures) {
    const expect = JSON.parse(readFileSync(path.join(ROOT, name, 'expect.json'), 'utf8'));
    const files = readTree(path.join(ROOT, name));
    const id = `fixture-${name}`;
    const created = await json(`${API}/projects`, { method: 'POST', body: JSON.stringify({ id, name, files }) });
    if (created.status !== 201) throw new Error(`Could not create ${name}: ${JSON.stringify(created.body)}`);
    // The stored copy must round-trip byte-for-byte (binary figures included).
    const stored = (await json(`${API}/projects/${id}`)).body.files;
    for (const f of files) {
      const s = stored.find(x => x.name === f.name);
      if (!s || s.content !== f.content) throw new Error(`${name}: ${f.name} did not round-trip through the API`);
    }

    const runs = expect.engines.map(engine => ({ engine, edit: null }));
    // Recompile after edits too: the first edit (a comment) takes the single direct pass, the second (a new labelled
    // section) changes the .aux and goes back through latexmk; pdfLaTeX also uses the cached preamble by then.
    if (expect.success && expect.engines.includes('pdflatex')) runs.push(
      { engine: 'pdflatex', edit: { label: 'edit', text: '% recompile check\n', expect: null } },
      { engine: 'pdflatex', edit: { label: 'new label', text: '\\section*{Recompile check}\\label{pd-recheck}Recompile check text \\pageref{pd-recheck}.\n', expect: 'recompile check text' } });
    for (const { engine, edit } of runs) {
      const t = Date.now();
      const sent = edit ? files.map(f => f.name === 'main.tex' ? { ...f, content: f.content.replace(/\\end\{document\}/, `${edit.text}\\end{document}`) } : f) : null;
      const { status, body } = await json(`${API}/projects/${id}/compile`, { method: 'POST', body: JSON.stringify({ engine, mainFile: 'main.tex', ...(sent ? { files: sent } : {}) }) });
      const problems = [];
      if (edit?.expect) expect.contains = [...(expect.contains ?? []), edit.expect];
      if (status !== 200) problems.push(`HTTP ${status}: ${body?.error}`);
      else if (expect.success) {
        if (!body.success) problems.push(`expected success, got errors: ${body.errors.map(e => `${e.file}:${e.line} ${e.message}`).join('; ')}`);
        const pdf = Buffer.from(await (await fetch(`${API}/projects/${id}/pdf`, { headers: ownerHeaders })).arrayBuffer());
        if (pdf.subarray(0, 5).toString() !== '%PDF-') problems.push('PDF missing');
        let doc = null;
        let pages = 0;
        let text = '';
        try {
          doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
          pages = doc.numPages;
          const pageData = await Promise.all(Array.from({ length: pages }, (_, i) => doc.getPage(i + 1).then(async p => ({ text: await p.getTextContent(), ops: await p.getOperatorList() }))));
          text = pageData.flatMap(x => x.text.items.map(it => it.str)).join(' ').replace(/\s+/g, ' ').toLowerCase();
          if (expect.image && !pageData.some(x => x.ops.fnArray.some(fn => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(fn)))) problems.push('PDF contains no rendered image operator');
        } catch (e) {
          problems.push(`PDF text parser failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await doc?.destroy();
        }
        for (const needle of expect.contains ?? []) if (!text.includes(needle.toLowerCase())) problems.push(`PDF text is missing “${needle}”`);
        if (/\?\s*\]|\[\s*\?/.test(text)) problems.push('PDF has unresolved citations ([?])');
        if (body.warnings.some(w => /Shell escape feature is not enabled/i.test(w.message))) problems.push('TeX ran without restricted shell escape');
        if (expect.minPages && pages < expect.minPages) problems.push(`expected ≥${expect.minPages} pages, got ${pages}`);
        if ((expect.bibtex || expect.bibliography === 'bibtex') && !/BibTeX|bibtex/i.test(body.log)) problems.push('BibTeX did not run');
        if (expect.bibliography === 'biber' && !/biber/i.test(body.log)) problems.push('Biber did not run');
        if ((expect.bibtex || expect.bibliography) && body.warnings.some(w => /undefined|Citation/.test(w.message) && /cit/i.test(w.message))) problems.push('undefined citations');
        const syncExpectation = expect.sync ?? (name === 'article' && engine === 'pdflatex' ? { file: 'main.tex', line: 13 } : null);
        if (syncExpectation) {
          const forward = await json(`${API}/projects/${id}/synctex`, { method: 'POST', body: JSON.stringify({ mode: 'forward', mainFile: 'main.tex', file: syncExpectation.file, line: syncExpectation.line, column: 1 }) });
          if (forward.status !== 200 || !forward.body?.found) problems.push(`SyncTeX source-to-PDF lookup failed: ${forward.body?.error ?? 'no position'}`);
          else {
            const inverse = await json(`${API}/projects/${id}/synctex`, { method: 'POST', body: JSON.stringify({ mode: 'inverse', mainFile: 'main.tex', page: forward.body.page, x: forward.body.x, y: forward.body.y }) });
            if (inverse.status !== 200 || !inverse.body?.found || inverse.body.file !== syncExpectation.file || inverse.body.line !== syncExpectation.line) problems.push(`SyncTeX PDF-to-source lookup failed: ${JSON.stringify(inverse.body)}`);
          }
        }
      } else {
        const e = body.errors[0];
        const want = expect.error;
        if (body.success) problems.push('expected a failure');
        else if (!e || e.file !== want.file || e.line !== want.line || !e.message.includes(want.messageIncludes)) {
          problems.push(`expected ${want.file}:${want.line} “${want.messageIncludes}”, got ${e ? `${e.file}:${e.line} “${e.message}”` : 'no error'}`);
        }
      }
      const secs = ((Date.now() - t) / 1000).toFixed(1).padStart(5);
      const timing = body?.timings ? `  [queue ${body.timings.queue}ms · sync ${body.timings.sync}ms · TeX+startup ${body.timings.tex}ms · read ${body.timings.read}ms · total ${body.timings.total}ms]` : '';
      const label = `${name.padEnd(20)} ${engine.padEnd(9)} ${secs}s${timing}${edit ? `  (${edit.label}: ${body?.timings?.passes === 1 ? 'single pass' : 'latexmk'})` : ''}`;
      if (edit?.expect) expect.contains = expect.contains.filter(c => c !== edit.expect);
      if (problems.length) { failures++; console.log(`  ✗ ${label}  ${problems.join(' | ')}`); if (expect.bibtex || expect.bibliography) console.log(body.log.slice(-5000)); }
      else console.log(`  ✓ ${label}${expect.success ? '' : `  error → ${body.errors[0].file}:${body.errors[0].line}`}`);
    }
  }
  // A newer compile replaces one still running: the first must get 410 (not hang) and the second must succeed
  // even though the first was killed part-way through writing its auxiliary files.
  const target = fixtures.find(n => n === 'ieee-template') ?? fixtures.find(n => JSON.parse(readFileSync(path.join(ROOT, n, 'expect.json'), 'utf8')).success);
  if (target) {
    const files = readTree(path.join(ROOT, target));
    const id = `fixture-${target}-replaced`;
    const edited = mark => files.map(f => f.name === 'main.tex' ? { ...f, content: f.content.replace(/\\end\{document\}/, `% ${mark}\n\\end{document}`) } : f);
    const send = mark => json(`${API}/projects/${id}/compile`, { method: 'POST', body: JSON.stringify({ engine: 'pdflatex', mainFile: 'main.tex', name: id, files: edited(mark) }) });
    await send('warm');
    const first = send('first');
    await new Promise(r => setTimeout(r, 300));
    const [a, b] = await Promise.all([first, send('second')]);
    const after = await send('third');
    const ok = (a.status === 410 || (a.status === 200 && a.body?.success)) && b.status === 200 && b.body?.success && after.body?.success;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${target.padEnd(20)} replaced compile: first ${a.status}, newer ${b.status} ${b.body?.success ? 'ok' : JSON.stringify(b.body?.errors?.slice(0, 1))}, next ${after.body?.success ? 'ok' : 'failed'}`);
    await fetch(`${API}/projects/${id}`, { method: 'DELETE', headers: ownerHeaders }).catch(() => undefined);
  }

  // Submission export: only needed files, the generated .bbl, no build files; the API compiles the ZIP on its own
  // in an empty folder before sending it, so a 200 here means the ZIP builds.
  const exportOf = async (id, files, kind, engine) => {
    const r = await fetch(`${API}/projects/${id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerHeaders }, body: JSON.stringify({ kind, engine, mainFile: 'main.tex', files }) });
    if (r.status !== 200) return { status: r.status, names: [], error: (await r.json().catch(() => null))?.error };
    const zip = await unzipper.Open.buffer(Buffer.from(await r.arrayBuffer()));
    return { status: 200, names: zip.files.map(f => f.path).sort() };
  };
  for (const name of ['article-template', 'biber', 'subfolders'].filter(n => fixtures.includes(n))) {
    const expect = JSON.parse(readFileSync(path.join(ROOT, name, 'expect.json'), 'utf8'));
    const engine = (expect.engines ?? ['pdflatex'])[0];
    const base = readTree(path.join(ROOT, name)).filter(f => !f.name.endsWith('/'));
    const extras = [{ name: 'main.aux', content: 'stale' }, { name: 'main.log', content: 'stale' }, { name: 'never-used.tex', content: 'Not part of the document.' }];
    const hasBib = base.some(f => f.name.endsWith('.bib'));
    for (const kind of ['arxiv', 'journal']) {
      const out = await exportOf(`fixture-export-${name}`, [...base, ...extras], kind, engine);
      const has = n => out.names.includes(n), any = pattern => out.names.some(n => pattern.test(n));
      const problems = [
        out.status !== 200 && `status ${out.status}: ${out.error}`,
        out.status === 200 && !has('main.tex') && 'main.tex missing',
        out.status === 200 && hasBib && !has('main.bbl') && 'main.bbl missing',
        any(/\.(aux|log|fls|fdb_latexmk|synctex\.gz|blg)$/) && 'build files included',
        has('never-used.tex') && 'unused file included',
        kind === 'arxiv' && any(/\.bib$/) && 'arXiv ZIP has .bib',
        kind === 'journal' && out.status === 200 && (!has('main.pdf') || (hasBib && !any(/\.bib$/))) && 'journal ZIP lacks the PDF or .bib',
      ].filter(Boolean);
      if (problems.length) failures++;
      console.log(`  ${problems.length ? '✗' : '✓'} ${name.padEnd(20)} ${kind} export: ${problems.length ? problems.join('; ') : `${out.names.length} files (${out.names.join(', ').slice(0, 90)})`}`);
    }
  }
  if (fixtures.includes('broken')) {
    const out = await exportOf('fixture-export-broken', readTree(path.join(ROOT, 'broken')).filter(f => !f.name.endsWith('/')), 'arxiv', 'pdflatex');
    const ok = out.status === 422;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${'broken'.padEnd(20)} export refused: ${out.status} ${out.error ?? ''}`);
  }
} catch (e) {
  failures++;
  console.error(`\n✗ ${e.message}`);
} finally {
  if (process.env.FIXTURE_API_URL && process.env.FIXTURE_OWNER_ID) {
    const fixtures = readdirSync(ROOT).filter(n => statSync(path.join(ROOT, n)).isDirectory() && (!only.length || only.includes(n)));
    await Promise.all(fixtures.map(id => fetch(`${API}/projects/fixture-${id}`, { method: 'DELETE', headers: ownerHeaders }).catch(() => undefined)));
  }
  cleanup();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll fixture compiles passed');
process.exit(failures ? 1 : 0);
