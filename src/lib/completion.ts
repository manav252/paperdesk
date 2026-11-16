// What to suggest while typing LaTeX: commands, environments, and names from the project itself
// (labels for \ref, citation keys for \cite, file paths for \includegraphics and \input).
import type { ProjectFile } from './project';

export type CompletionKind = 'command' | 'env' | 'ref' | 'cite' | 'graphics' | 'input' | 'bib';
export type CompletionContext = { kind: CompletionKind; partial: string };

const REF = /\\(?:ref|eqref|autoref|pageref|nameref|cref|Cref|vref)\{([^}]*)$/;
const CITE =
  /\\(?:cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)$/;
const GRAPHICS = /\\includegraphics\*?(?:\[[^\]]*\])?\{([^}]*)$/;
const INPUT = /\\(?:input|include|subfile|includeonly)\{([^}]*)$/;
const BIB = /\\(?:bibliography|addbibresource)\{([^}]*)$/;
const ENV = /\\(?:begin|end)\{([^}]*)$/;
const COMMAND = /\\([a-zA-Z]*)$/;

/** Decides what is being typed from the text of the line before the cursor. */
export function completionContext(before: string): CompletionContext | null {
  let m: RegExpExecArray | null;
  if ((m = REF.exec(before))) return { kind: 'ref', partial: m[1] };
  if ((m = CITE.exec(before))) return { kind: 'cite', partial: m[1].split(',').pop()!.trimStart() };
  if ((m = GRAPHICS.exec(before))) return { kind: 'graphics', partial: m[1] };
  if ((m = INPUT.exec(before))) return { kind: 'input', partial: m[1] };
  if ((m = BIB.exec(before))) return { kind: 'bib', partial: m[1].split(',').pop()!.trimStart() };
  if ((m = ENV.exec(before))) return { kind: 'env', partial: m[1] };
  if ((m = COMMAND.exec(before))) return { kind: 'command', partial: m[1] };
  return null;
}

const text = (files: ProjectFile[], ext: RegExp) =>
  files
    .filter((f) => ext.test(f.name) && f.encoding !== 'base64')
    .map((f) => ({ name: f.name, content: f.content.replace(/(^|[^\\])%.*$/gm, '$1') }));

/** \label{...} in every .tex file, with the file and line it is on. */
export function collectLabels(files: ProjectFile[]) {
  const out: { label: string; file: string; line: number }[] = [];
  for (const f of text(files, /\.tex$/i)) {
    f.content.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\\label\{([^}]+)\}/g)) out.push({ label: m[1], file: f.name, line: i + 1 });
    });
  }
  return out;
}

/** Citation keys from .bib entries and \bibitem, with a short title where one is available. */
export function collectCitations(files: ProjectFile[]) {
  const out = new Map<string, string>();
  for (const f of text(files, /\.bib$/i)) {
    for (const m of f.content.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g)) {
      if (/^(string|comment|preamble)$/i.test(m[1])) continue;
      const title = /\btitle\s*=\s*[{"]+([^}"]+)/i.exec(m[3])?.[1] ?? m[1];
      out.set(m[2], title.replace(/\s+/g, ' ').trim());
    }
  }
  for (const f of text(files, /\.tex$/i))
    for (const m of f.content.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}([^\n]*)/g))
      out.set(m[1], m[2].trim().slice(0, 80) || 'Bibliography item');
  return [...out].map(([key, detail]) => ({ key, detail }));
}

/** Project paths suitable for a command: images for \includegraphics, .tex for \input, .bib for \bibliography. */
export function projectPaths(files: ProjectFile[], kind: 'graphics' | 'input' | 'bib') {
  const pattern = kind === 'graphics' ? /\.(png|jpe?g|pdf|eps)$/i : kind === 'input' ? /\.tex$/i : /\.bib$/i;
  return files
    .filter((f) => !f.name.endsWith('/') && pattern.test(f.name))
    .map((f) => (kind === 'graphics' ? f.name : f.name.replace(kind === 'input' ? /\.tex$/i : /\.bib$/i, '')));
}

/** [name, snippet body, description]. `$1`, `$0` are snippet tab stops. */
export const COMMANDS: [string, string, string][] = [
  ['section', '\\section{$1}', 'Section heading'],
  ['section*', '\\section*{$1}', 'Unnumbered section'],
  ['subsection', '\\subsection{$1}', 'Subsection heading'],
  ['subsubsection', '\\subsubsection{$1}', 'Subsubsection heading'],
  ['chapter', '\\chapter{$1}', 'Chapter (book, report)'],
  ['paragraph', '\\paragraph{$1}', 'Run-in paragraph heading'],
  ['textbf', '\\textbf{$1}', 'Bold'],
  ['textit', '\\textit{$1}', 'Italic'],
  ['emph', '\\emph{$1}', 'Emphasis'],
  ['underline', '\\underline{$1}', 'Underline'],
  ['texttt', '\\texttt{$1}', 'Monospace'],
  ['textsc', '\\textsc{$1}', 'Small caps'],
  ['textcolor', '\\textcolor{${1:red}}{$2}', 'Coloured text (xcolor)'],
  ['footnote', '\\footnote{$1}', 'Footnote'],
  ['label', '\\label{$1}', 'Label for cross-references'],
  ['ref', '\\ref{$1}', 'Reference a label'],
  ['eqref', '\\eqref{$1}', 'Reference an equation (amsmath)'],
  ['pageref', '\\pageref{$1}', 'Page of a label'],
  ['autoref', '\\autoref{$1}', 'Reference with its name (hyperref)'],
  ['cref', '\\cref{$1}', 'Clever reference (cleveref)'],
  ['cite', '\\cite{$1}', 'Citation'],
  ['citep', '\\citep{$1}', 'Parenthetical citation (natbib)'],
  ['citet', '\\citet{$1}', 'Textual citation (natbib)'],
  ['parencite', '\\parencite{$1}', 'Parenthetical citation (biblatex)'],
  ['textcite', '\\textcite{$1}', 'Textual citation (biblatex)'],
  ['includegraphics', '\\includegraphics[width=${1:0.8}\\linewidth]{$2}', 'Image'],
  ['caption', '\\caption{$1}', 'Caption'],
  ['centering', '\\centering', 'Centre the float contents'],
  ['input', '\\input{$1}', 'Insert another file'],
  ['include', '\\include{$1}', 'Include a chapter file'],
  ['usepackage', '\\usepackage{$1}', 'Load a package'],
  ['documentclass', '\\documentclass{${1:article}}', 'Document class'],
  ['title', '\\title{$1}', 'Title'],
  ['author', '\\author{$1}', 'Author'],
  ['date', '\\date{$1}', 'Date'],
  ['maketitle', '\\maketitle', 'Print the title'],
  ['tableofcontents', '\\tableofcontents', 'Table of contents'],
  ['listoffigures', '\\listoffigures', 'List of figures'],
  ['listoftables', '\\listoftables', 'List of tables'],
  ['bibliography', '\\bibliography{$1}', 'BibTeX database'],
  ['bibliographystyle', '\\bibliographystyle{${1:plain}}', 'BibTeX style'],
  ['addbibresource', '\\addbibresource{$1.bib}', 'Bibliography file (biblatex)'],
  ['printbibliography', '\\printbibliography', 'Print the bibliography (biblatex)'],
  ['item', '\\item $0', 'List item'],
  ['newpage', '\\newpage', 'New page'],
  ['clearpage', '\\clearpage', 'Flush floats and start a page'],
  ['hspace', '\\hspace{$1}', 'Horizontal space'],
  ['vspace', '\\vspace{$1}', 'Vertical space'],
  ['newline', '\\newline', 'Line break'],
  ['noindent', '\\noindent', 'No paragraph indent'],
  ['url', '\\url{$1}', 'URL (hyperref/url)'],
  ['href', '\\href{$1}{$2}', 'Hyperlink (hyperref)'],
  ['newcommand', '\\newcommand{\\\\$1}{$2}', 'Define a command'],
  ['renewcommand', '\\renewcommand{\\\\$1}{$2}', 'Redefine a command'],
  ['toprule', '\\toprule', 'Top rule (booktabs)'],
  ['midrule', '\\midrule', 'Middle rule (booktabs)'],
  ['bottomrule', '\\bottomrule', 'Bottom rule (booktabs)'],
  ['cmidrule', '\\cmidrule(lr){$1}', 'Partial rule (booktabs)'],
  ['hline', '\\hline', 'Horizontal line'],
  ['multicolumn', '\\multicolumn{${1:2}}{${2:c}}{$3}', 'Cell spanning columns'],
  ['multirow', '\\multirow{${1:2}}{*}{$2}', 'Cell spanning rows (multirow)'],
  ['frac', '\\frac{$1}{$2}', 'Fraction'],
  ['sqrt', '\\sqrt{$1}', 'Square root'],
  ['sum', '\\sum_{$1}^{$2}', 'Sum'],
  ['int', '\\int_{$1}^{$2}', 'Integral'],
  ['prod', '\\prod_{$1}^{$2}', 'Product'],
  ['lim', '\\lim_{$1}', 'Limit'],
  ['infty', '\\infty', '∞'],
  ['partial', '\\partial', '∂'],
  ['mathbb', '\\mathbb{$1}', 'Blackboard bold (amssymb)'],
  ['mathbf', '\\mathbf{$1}', 'Bold math'],
  ['mathcal', '\\mathcal{$1}', 'Calligraphic'],
  ['mathrm', '\\mathrm{$1}', 'Upright math'],
  ['text', '\\text{$1}', 'Text inside math (amsmath)'],
  ['left', '\\left$1 $0 \\right$2', 'Sized delimiters'],
  ['alpha', '\\alpha', 'α'],
  ['beta', '\\beta', 'β'],
  ['gamma', '\\gamma', 'γ'],
  ['delta', '\\delta', 'δ'],
  ['epsilon', '\\epsilon', 'ϵ'],
  ['varepsilon', '\\varepsilon', 'ε'],
  ['theta', '\\theta', 'θ'],
  ['lambda', '\\lambda', 'λ'],
  ['mu', '\\mu', 'μ'],
  ['pi', '\\pi', 'π'],
  ['sigma', '\\sigma', 'σ'],
  ['phi', '\\phi', 'ϕ'],
  ['omega', '\\omega', 'ω'],
  ['Delta', '\\Delta', 'Δ'],
  ['Sigma', '\\Sigma', 'Σ'],
  ['Omega', '\\Omega', 'Ω'],
  ['leq', '\\leq', '≤'],
  ['geq', '\\geq', '≥'],
  ['neq', '\\neq', '≠'],
  ['approx', '\\approx', '≈'],
  ['cdot', '\\cdot', '·'],
  ['times', '\\times', '×'],
  ['in', '\\in', '∈'],
  ['subseteq', '\\subseteq', '⊆'],
  ['forall', '\\forall', '∀'],
  ['exists', '\\exists', '∃'],
  ['rightarrow', '\\rightarrow', '→'],
  ['Rightarrow', '\\Rightarrow', '⇒'],
];

/** [environment, body]; the body sits between \begin{env} and \end{env}. */
export const ENVIRONMENTS: [string, string][] = [
  ['document', '$0'],
  ['abstract', '$0'],
  ['itemize', '\t\\item $0'],
  ['enumerate', '\t\\item $0'],
  ['description', '\t\\item[$1] $0'],
  ['figure', '\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{$1}\n\t\\caption{$2}\n\t\\label{fig:$3}'],
  ['table', '\t\\centering\n\t\\caption{$1}\n\t\\label{tab:$2}\n\t\\begin{tabular}{${3:lc}}\n\t\t$0\n\t\\end{tabular}'],
  ['tabular', '\t$0'],
  ['longtable', '\t$0'],
  ['center', '\t$0'],
  ['minipage', '\t$0'],
  ['subfigure', '\t$0'],
  ['equation', '\t$0'],
  ['equation*', '\t$0'],
  ['align', '\t$0'],
  ['align*', '\t$0'],
  ['gather', '\t$0'],
  ['multline', '\t$0'],
  ['split', '\t$0'],
  ['cases', '\t$1 & $2 \\\\\\\\\n\t$0'],
  ['pmatrix', '\t$0'],
  ['bmatrix', '\t$0'],
  ['matrix', '\t$0'],
  ['theorem', '\t$0'],
  ['lemma', '\t$0'],
  ['proof', '\t$0'],
  ['definition', '\t$0'],
  ['quote', '\t$0'],
  ['verbatim', '$0'],
  ['thebibliography', '\t\\bibitem{$1} $0'],
  ['frame', '\t\\frametitle{$1}\n\t$0'],
];

// ── Typst ──

export type TypstContext =
  | { kind: 'function'; partial: string }
  | { kind: 'ref'; partial: string }
  | { kind: 'path'; partial: string; files: 'image' | 'typ' | 'bib' };

/** What is being typed before the cursor in a .typ file: a `#function`, an `@reference`, or a file path. */
export function typstCompletionContext(before: string): TypstContext | null {
  let m = /(?:image|read|csv|json|yaml|toml)\(\s*"([^"]*)$/.exec(before);
  if (m) return { kind: 'path', partial: m[1]!, files: 'image' };
  m = /(?:#include\s+|import\s+)"([^"]*)$/.exec(before);
  if (m) return { kind: 'path', partial: m[1]!, files: 'typ' };
  m = /bibliography\(\s*"([^"]*)$/.exec(before);
  if (m) return { kind: 'path', partial: m[1]!, files: 'bib' };
  m = /(?:^|[^\w@])@([\w:.-]*)$/.exec(before);
  if (m) return { kind: 'ref', partial: m[1]! };
  m = /#([A-Za-z][\w.-]*)?$/.exec(before);
  if (m) return { kind: 'function', partial: m[1] ?? '' };
  return null;
}

/** Labels (`<name>`) in the project's Typst files and keys of its .bib files, for `@` references and citations. */
export function collectTypstReferences(files: ProjectFile[]) {
  const out: { key: string; detail: string }[] = [];
  for (const f of text(files, /\.typ$/i))
    f.content.split('\n').forEach((line, i) => {
      for (const m of line.replace(/\/\/.*$/, '').matchAll(/<([A-Za-z_][\w:.-]*)>/g))
        out.push({ key: m[1]!, detail: `${f.name}:${i + 1}` });
    });
  for (const c of collectCitations(files)) out.push(c);
  for (const f of text(files, /\.ya?ml$/i))
    for (const m of f.content.matchAll(/^([A-Za-z_][\w:.-]*):\s*$/gm)) out.push({ key: m[1]!, detail: f.name });
  return out;
}

/** A project path written relative to the folder of the file that refers to it, as Typst resolves paths. */
export function relativePath(fromFile: string, target: string) {
  const from = fromFile.split('/').slice(0, -1),
    to = target.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...Array(from.length - shared).fill('..'), ...to.slice(shared)].join('/');
}

/** Paths a Typst function can take: images, other .typ files, or bibliography files. */
export function typstPaths(files: ProjectFile[], kind: 'image' | 'typ' | 'bib', fromFile: string) {
  const pattern = kind === 'image' ? /\.(png|jpe?g|gif|svg|webp)$/i : kind === 'typ' ? /\.typ$/i : /\.(bib|ya?ml)$/i;
  return files
    .filter((f) => !f.name.endsWith('/') && f.name !== fromFile && pattern.test(f.name))
    .map((f) => relativePath(fromFile, f.name));
}

/** [name, snippet after `#`, description] for common Typst functions and keywords. */
export const TYPST_FUNCTIONS: [string, string, string][] = [
  ['set', 'set ${1:text}(${2})', 'Set rule: change defaults from here on'],
  ['show', 'show ${1:heading}: ${2:it => it}', 'Show rule: restyle an element'],
  ['let', 'let ${1:name} = ${2}', 'Define a variable or function'],
  ['import', 'import "${1}": ${2}', 'Import from another file'],
  ['include', 'include "${1}"', 'Include another .typ file here'],
  ['heading', 'heading(level: ${1:1})[${2}]', 'Heading'],
  [
    'figure',
    'figure(\n  image("${1}", width: ${2:80%}),\n  caption: [${3}],\n) <${4:fig:label}>',
    'Figure with caption and label',
  ],
  ['image', 'image("${1}", width: ${2:100%})', 'Image from the project'],
  ['table', 'table(\n  columns: ${1:2},\n  [${2:A}], [${3:B}],\n)', 'Table'],
  ['bibliography', 'bibliography("${1:references.bib}")', 'Bibliography from a .bib or .yml file'],
  ['cite', 'cite(<${1:key}>)', 'Citation'],
  ['ref', 'ref(<${1:label}>)', 'Reference to a label'],
  ['link', 'link("${1:https://}")[${2}]', 'Link'],
  ['footnote', 'footnote[${1}]', 'Footnote'],
  ['outline', 'outline()', 'Table of contents'],
  ['pagebreak', 'pagebreak()', 'Page break'],
  ['align', 'align(${1:center})[${2}]', 'Align content'],
  ['text', 'text(${1:size: 12pt})[${2}]', 'Text with style'],
  ['strong', 'strong[${1}]', 'Bold text'],
  ['emph', 'emph[${1}]', 'Italic text'],
  ['underline', 'underline[${1}]', 'Underlined text'],
  ['smallcaps', 'smallcaps[${1}]', 'Small capitals'],
  ['highlight', 'highlight[${1}]', 'Highlighted text'],
  ['strike', 'strike[${1}]', 'Struck-through text'],
  ['super', 'super[${1}]', 'Superscript'],
  ['sub', 'sub[${1}]', 'Subscript'],
  ['quote', 'quote(block: true)[${1}]', 'Quotation'],
  ['list', 'list(\n  [${1}],\n)', 'Bulleted list'],
  ['enum', 'enum(\n  [${1}],\n)', 'Numbered list'],
  ['grid', 'grid(\n  columns: ${1:2},\n  gutter: ${2:1em},\n  [${3}], [${4}],\n)', 'Grid layout'],
  ['columns', 'columns(${1:2})[${2}]', 'Multi-column content'],
  ['box', 'box(${1})[${2}]', 'Inline box'],
  ['block', 'block(${1})[${2}]', 'Block'],
  ['rect', 'rect(${1})[${2}]', 'Rectangle'],
  ['line', 'line(length: ${1:100%})', 'Horizontal line'],
  ['v', 'v(${1:1em})', 'Vertical space'],
  ['h', 'h(${1:1em})', 'Horizontal space'],
  ['place', 'place(${1:top + center})[${2}]', 'Place content freely'],
  ['page', 'page(${1})[${2}]', 'Page with its own settings'],
  ['par', 'par(${1:justify: true})[${2}]', 'Paragraph settings'],
  ['raw', 'raw("${1}", lang: "${2}")', 'Code'],
  ['counter', 'counter(${1:page}).display()', 'Counter'],
  ['datetime.today', 'datetime.today().display()', "Today's date"],
  ['lorem', 'lorem(${1:30})', 'Placeholder text'],
];
