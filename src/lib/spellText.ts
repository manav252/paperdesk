/** A word of prose in a LaTeX source, with its character offset in that source. */
export type ProseWord = { word: string; offset: number };

// Commands whose braced arguments are keys, file names or code rather than prose.
const SKIP_ARGS = new Set([
  'cite', 'citep', 'citet', 'citealp', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite', 'autocite', 'footcite',
  'ref', 'eqref', 'pageref', 'cref', 'Cref', 'autoref', 'nameref', 'label', 'url', 'href', 'hyperref',
  'begin', 'end', 'usepackage', 'RequirePackage', 'documentclass', 'input', 'include', 'includeonly', 'includegraphics',
  'bibliography', 'bibliographystyle', 'addbibresource', 'graphicspath', 'newcommand', 'renewcommand', 'providecommand',
  'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'setlength', 'addtolength', 'setcounter', 'addtocounter',
  'newcounter', 'pagestyle', 'thispagestyle', 'pagenumbering', 'color', 'textcolor', 'definecolor', 'hspace', 'vspace',
  'verb', 'lstinline', 'mintinline', 'input', 'subfile', 'newtheorem', 'theoremstyle', 'geometry', 'hypersetup',
  'fontsize', 'selectfont', 'usetikzlibrary', 'tikzset', 'pgfplotsset', 'multicolumn', 'multirow', 'cline', 'cmidrule',
]);
// Environments whose whole body is math or code.
const SKIP_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath|split|verbatim|Verbatim|lstlisting|minted|comment|tikzpicture|array|filecontents)\*?$/;
const WORD = /[A-Za-zÀ-ɏ]+(?:['’][A-Za-zÀ-ɏ]+)*/y;

/**
 * Finds the words of prose in a LaTeX source: skips comments, commands, math, the arguments of commands such as
 * \cite and \ref, and math or code environments. Words with digits and single letters are left out.
 */
export function proseWords(source: string): ProseWord[] {
  const words: ProseWord[] = [];
  const n = source.length;
  let i = 0;

  /** Index just past the group that opens at `start` ({…} or […]), allowing nesting and escapes. */
  const skipGroup = (start: number, open: string, close: string) => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      const c = source[j];
      if (c === '\\') { j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return n;
  };
  const skipSpaces = (j: number) => { while (j < n && (source[j] === ' ' || source[j] === '\t')) j++; return j; };
  /** Index of the end of `\end{name}` after `from`, or the end of the source. */
  const endOfEnv = (name: string, from: number) => {
    const at = source.indexOf(`\\end{${name}}`, from);
    return at < 0 ? n : at + `\\end{${name}}`.length;
  };
  const endOfMath = (close: string, from: number) => {
    for (let j = from; j < n; j++) {
      if (source[j] === '\\' && !source.startsWith(close, j)) { j++; continue; }
      if (source.startsWith(close, j)) return j + close.length;
    }
    return n;
  };

  while (i < n) {
    const c = source[i]!;
    if (c === '%') { const nl = source.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (c === '$') {
      const display = source[i + 1] === '$';
      i = endOfMath(display ? '$$' : '$', i + (display ? 2 : 1));
      continue;
    }
    if (c === '\\') {
      const next = source[i + 1];
      if (next === '(') { i = endOfMath('\\)', i + 2); continue; }
      if (next === '[') { i = endOfMath('\\]', i + 2); continue; }
      const name = /^[A-Za-z@]+\*?/.exec(source.slice(i + 1, i + 60))?.[0];
      if (!name) { i += 2; continue; }
      let j = i + 1 + name.length;
      const base = name.replace(/\*$/, '');
      if (base === 'begin') {
        const env = /^\s*\{([^}]*)\}/.exec(source.slice(j, j + 80));
        if (env && SKIP_ENVS.test(env[1]!)) { i = endOfEnv(env[1]!, j); continue; }
        if (env) j += env[0].length;
        // Optional and table-spec arguments right after \begin{…}.
        for (j = skipSpaces(j); source[j] === '[' || (source[j] === '{' && /^(tabular|tabularx|longtable|minipage|wrapfigure)/.test(env?.[1] ?? '')); j = skipSpaces(j)) j = skipGroup(j, source[j]!, source[j] === '[' ? ']' : '}');
        i = j; continue;
      }
      if (base === 'verb') { const delim = source[j]; const close = delim ? source.indexOf(delim, j + 1) : -1; i = close < 0 ? n : close + 1; continue; }
      if (SKIP_ARGS.has(base)) {
        for (j = skipSpaces(j); source[j] === '[' || source[j] === '{'; j = skipSpaces(j)) j = skipGroup(j, source[j]!, source[j] === '[' ? ']' : '}');
        i = j; continue;
      }
      // Optional arguments of other commands are settings (e.g. \section[short]{…} keeps the short title as prose).
      if (source[j] === '[' && !/^(section|subsection|subsubsection|chapter|paragraph|caption|item|footnote)$/.test(base)) j = skipGroup(j, '[', ']');
      i = j; continue;
    }
    WORD.lastIndex = i;
    const m = WORD.exec(source);
    if (m) {
      const end = i + m[0].length;
      // Skip parts of identifiers such as fig1 or my_label.
      const touching = /[0-9_]/.test(source[end] ?? '') || /[0-9_]/.test(source[i - 1] ?? '');
      if (m[0].length > 1 && !touching) words.push({ word: m[0].replace(/’/g, "'"), offset: i });
      i = end; continue;
    }
    i++;
  }
  return words;
}
