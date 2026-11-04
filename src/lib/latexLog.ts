/** Parses TeX (run with -file-line-error) and BibTeX logs into errors and warnings with file and line. */
export type LogEntry = { file: string | null; line: number | null; message: string };

const SOURCE_EXT = 'tex|sty|cls|bib|bbl|ltx|def|cfg|clo|aux|toc|lof|lot|out|fd';
const FILE_LINE_ERROR = new RegExp(`^(\\S[^:]*?\\.(?:${SOURCE_EXT})):(\\d+): (.*)$`);
const OPEN_FILE = new RegExp(`\\(((?:\\.{0,2}/)?[^\\s()]+\\.(?:${SOURCE_EXT}))`, 'g');

/** TeX hard-wraps log lines at 79 characters; join them back so messages and paths aren't split. */
export function unwrapTexLog(log: string, width = 79) {
  const out: string[] = [];
  let buf = '';
  for (const line of log.split(/\r?\n/)) {
    buf += line;
    if (line.length !== width) { out.push(buf); buf = ''; }
  }
  if (buf) out.push(buf);
  return out;
}

const cleanFile = (f: string) => f.replace(/^\.\//, '');

export function parseLatexLog(texLog: string, bibtexLog = '', mainFile = 'main.tex') {
  const errors: LogEntry[] = [];
  const warnings: LogEntry[] = [];
  const lines = unwrapTexLog(texLog);
  // Approximate which file TeX is reading by tracking "(file" opens and ")" closes.
  const stack: string[] = [];
  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (!stack[i].startsWith('/')) return stack[i];
    return mainFile;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fle = FILE_LINE_ERROR.exec(line);
    if (fle) {
      const detail = followingDetail(lines, i);
      errors.push({ file: cleanFile(fle[1]), line: Number(fle[2]), message: joinMessage(fle[3], detail) });
      continue;
    }
    if (line.startsWith('! ')) {
      // Errors not in file:line form (e.g. emergency stops); find the "l.<n>" context line.
      const ctx = lines.slice(i + 1, i + 12).find(l => /^l\.\d+/.test(l));
      const ln = ctx ? Number(/^l\.(\d+)/.exec(ctx)![1]) : null;
      const rawMessage = line.slice(2).trim();
      const missingFile = /^LaTeX Error: File [`'](.+?)[`'] not found\.?$/.exec(rawMessage);
      const message = missingFile ? `Image or file “${missingFile[1]}” was not found. Check the path on this line.` : rawMessage;
      const isFollowOn = /^(Emergency stop|==> Fatal error occurred)/.test(message) && errors.length > 0;
      if (!isFollowOn) errors.push({ file: currentFile(), line: ln, message });
      continue;
    }

    const warn = /^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/.exec(line);
    if (warn) {
      let text = warn[3];
      // Package warnings continue on lines prefixed with "(pkgname)".
      for (let j = i + 1; j < lines.length && lines[j].trim() && !/^(?:LaTeX|Package|Class) /.test(lines[j]); j++) {
        text += ' ' + lines[j].replace(/^\([^)]*\)\s*/, '').trim();
      }
      const at = /on input line (\d+)\.?/.exec(text);
      const who = warn[1] ? `${warn[1]}: ` : warn[2] ? `${warn[2]}: ` : '';
      warnings.push({ file: currentFile(), line: at ? Number(at[1]) : null, message: who + text.replace(/\s*on input line \d+\.?/, '').replace(/\s+/g, ' ').trim() });
      continue;
    }
    const box = /^(Overfull|Underfull) \\[hv]box .*? (?:in paragraph at lines (\d+)--\d+|detected at line (\d+)|has occurred while \\output is active)/.exec(line);
    if (box) {
      warnings.push({ file: currentFile(), line: box[2] ? Number(box[2]) : box[3] ? Number(box[3]) : null, message: line.replace(/\s*\[\]\s*$/, '').trim() });
    }

    // Update the file stack after reading messages on this line.
    for (const ch of tokenize(line)) {
      if (ch === ')') stack.pop();
      else stack.push(cleanFile(ch));
    }
  }

  const bib = parseBibtexLog(bibtexLog);
  return { errors: dedupe([...errors, ...bib.errors]), warnings: dedupe([...warnings, ...bib.warnings]) };
}

function tokenize(line: string) {
  const tokens: string[] = [];
  let last = 0;
  OPEN_FILE.lastIndex = 0;
  for (let m = OPEN_FILE.exec(line); m; m = OPEN_FILE.exec(line)) {
    for (const c of line.slice(last, m.index)) if (c === ')') tokens.push(')');
    tokens.push(m[1]);
    last = m.index + m[0].length;
  }
  for (const c of line.slice(last)) if (c === ')') tokens.push(')');
  return tokens;
}

/** The context lines TeX prints after an error ("l.12 \foo" and its continuation), trimmed. */
function followingDetail(lines: string[], i: number) {
  const ctx = lines.slice(i + 1, i + 8);
  const at = ctx.findIndex(l => /^l\.\d+ /.test(l));
  if (at < 0) return '';
  const code = ctx[at].replace(/^l\.\d+ /, '') + (ctx[at + 1]?.trim() ? ctx[at + 1].trim() : '');
  return code.trim();
}

const joinMessage = (msg: string, detail: string) => (detail && !msg.includes(detail) ? `${msg.trim()} — ${detail}` : msg.trim());

export function parseBibtexLog(blg: string) {
  const errors: LogEntry[] = [];
  const warnings: LogEntry[] = [];
  const lines = blg.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const at = /---line (\d+) of file (.+)$/.exec(line);
    if (at) {
      const msg = line.slice(0, at.index).trim() || lines[i - 1]?.trim() || 'BibTeX error';
      errors.push({ file: at[2].trim(), line: Number(at[1]), message: `BibTeX: ${msg}` });
      continue;
    }
    const open = /^I couldn't open ((?:database|style|auxiliary) file .+)$/.exec(line);
    if (open) { errors.push({ file: null, line: null, message: `BibTeX: couldn't open ${open[1].trim()}` }); continue; }
    const w = /^Warning--(.*)$/.exec(line);
    if (w) {
      const where = /--line (\d+) of file (.+)$/.exec(lines[i + 1] ?? '');
      warnings.push({ file: where ? where[2].trim() : null, line: where ? Number(where[1]) : null, message: `BibTeX: ${w[1].trim()}` });
    }
  }
  return { errors, warnings };
}

function dedupe(list: LogEntry[]) {
  const seen = new Set<string>();
  return list.filter(e => {
    const key = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
