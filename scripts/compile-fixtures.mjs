#!/usr/bin/env node
// End-to-end compile check: uploads each project in test/fixtures/compile through the real API,
// compiles it with every engine listed in its expect.json, and checks the PDF or the reported error.
// Needs Docker and the compiler image (npm run compiler:build). Usage: npm run test:compile [-- name ...]
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve('test/fixtures/compile');
const PORT = Number(process.env.FIXTURE_PORT ?? 3101);
const API = `http://localhost:${PORT}/api`;
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
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};

const data = mkdtempSync(path.join(tmpdir(), 'paperdesk-fixtures-'));
const server = spawn('npx', ['tsx', 'server.ts'], { env: { ...process.env, PORT: String(PORT), PAPERDESK_DATA: data }, stdio: ['ignore', 'pipe', 'inherit'] });
const cleanup = () => { server.kill(); rmSync(data, { recursive: true, force: true }); };
process.on('SIGINT', () => { cleanup(); process.exit(130); });

let failures = 0;
try {
  let health = null;
  for (let i = 0; i < 60 && !health; i++) {
    health = await fetch(`${API}/health`).then(r => r.json()).catch(() => null);
    if (!health) await new Promise(r => setTimeout(r, 500));
  }
  if (!health) throw new Error('API did not start');
  if (!health.docker) throw new Error('Docker is not running');
  if (!health.image) throw new Error(`Compiler image ${health.compilerImage} is missing; run npm run compiler:build`);

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

    for (const engine of expect.engines) {
      const t = Date.now();
      const { status, body } = await json(`${API}/projects/${id}/compile`, { method: 'POST', body: JSON.stringify({ engine, mainFile: 'main.tex' }) });
      const problems = [];
      if (status !== 200) problems.push(`HTTP ${status}: ${body?.error}`);
      else if (expect.success) {
        if (!body.success) problems.push(`expected success, got errors: ${body.errors.map(e => `${e.file}:${e.line} ${e.message}`).join('; ')}`);
        const pdf = Buffer.from(await (await fetch(`${API}/projects/${id}/pdf`)).arrayBuffer());
        if (pdf.subarray(0, 5).toString() !== '%PDF-') problems.push('PDF missing');
        let doc = null;
        let pages = 0;
        let text = '';
        try {
          doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise;
          pages = doc.numPages;
          text = (await Promise.all(Array.from({ length: pages }, (_, i) => doc.getPage(i + 1).then(p => p.getTextContent())))).flatMap(c => c.items.map(it => it.str)).join(' ').replace(/\s+/g, ' ').toLowerCase();
        } catch (e) {
          problems.push(`PDF text parser failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          await doc?.destroy();
        }
        for (const needle of expect.contains ?? []) if (!text.includes(needle.toLowerCase())) problems.push(`PDF text is missing “${needle}”`);
        if (/\?\s*\]|\[\s*\?/.test(text)) problems.push('PDF has unresolved citations ([?])');
        if (expect.minPages && pages < expect.minPages) problems.push(`expected ≥${expect.minPages} pages, got ${pages}`);
        if ((expect.bibtex || expect.bibliography === 'bibtex') && !/BibTeX|bibtex/i.test(body.log)) problems.push('BibTeX did not run');
        if (expect.bibliography === 'biber' && !/biber/i.test(body.log)) problems.push('Biber did not run');
        if ((expect.bibtex || expect.bibliography) && body.warnings.some(w => /undefined|Citation/.test(w.message) && /cit/i.test(w.message))) problems.push('undefined citations');
      } else {
        const e = body.errors[0];
        const want = expect.error;
        if (body.success) problems.push('expected a failure');
        else if (!e || e.file !== want.file || e.line !== want.line || !e.message.includes(want.messageIncludes)) {
          problems.push(`expected ${want.file}:${want.line} “${want.messageIncludes}”, got ${e ? `${e.file}:${e.line} “${e.message}”` : 'no error'}`);
        }
      }
      const secs = ((Date.now() - t) / 1000).toFixed(1).padStart(5);
      const label = `${name.padEnd(12)} ${engine.padEnd(9)} ${secs}s`;
      if (problems.length) { failures++; console.log(`  ✗ ${label}  ${problems.join(' | ')}`); if (expect.bibtex || expect.bibliography) console.log(body.log.slice(-5000)); }
      else console.log(`  ✓ ${label}${expect.success ? '' : `  error → ${body.errors[0].file}:${body.errors[0].line}`}`);
    }
  }
} catch (e) {
  failures++;
  console.error(`\n✗ ${e.message}`);
} finally {
  cleanup();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll fixture compiles passed');
process.exit(failures ? 1 : 0);
