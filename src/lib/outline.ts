/** Sectioning commands of a .tex file, for the file outline. Commented-out headings are skipped. */
const LEVELS: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };

export function outlineOf(content: string) {
  const out: { level: number; title: string; line: number }[] = [];
  content.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|[^\\])%.*$/, '$1');
    for (const m of line.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
      out.push({ level: LEVELS[m[1]], title: m[2].replace(/\\[a-zA-Z]+\s*/g, '').replace(/[{}]/g, '').trim() || '(untitled)', line: i + 1 });
    }
  });
  const top = Math.min(...out.map(o => o.level), 9);
  return out.map(o => ({ ...o, level: o.level - top }));
}
