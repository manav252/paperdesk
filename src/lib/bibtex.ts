/** Building BibTeX entries from Crossref and arXiv metadata. Pure, shared by the API and the app. */
export type BibEntry = { type: string; key: string; fields: [string, string][] };
export type Identifier = { kind: 'doi' | 'arxiv'; id: string };

const ARXIV_NEW = /(\d{4}\.\d{4,5})(v\d+)?/,
  ARXIV_OLD = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/;

/** Reads a DOI, a doi.org link, an arXiv id or an arxiv.org link. Null when the text is none of these. */
export function parseIdentifier(input: string): Identifier | null {
  const text = input.trim().replace(/^<|>$/g, '');
  if (!text) return null;
  const arxivDoi = /10\.48550\/arxiv\.(.+)$/i.exec(text);
  const arxivText = arxivDoi?.[1] ?? /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)(.+)$/i.exec(text)?.[1];
  if (arxivText !== undefined) {
    const id = (ARXIV_NEW.exec(arxivText) ?? ARXIV_OLD.exec(arxivText))?.[1];
    return id ? { kind: 'arxiv', id } : null;
  }
  const doi = /(10\.\d{4,9}\/[^\s"<>]+)/.exec(text)?.[1];
  if (doi) return { kind: 'doi', id: doi.replace(/[.,;)\]]+$/, '').toLowerCase() };
  const bare = new RegExp(`^${ARXIV_NEW.source}$`).exec(text) ?? new RegExp(`^${ARXIV_OLD.source}$`).exec(text);
  return bare ? { kind: 'arxiv', id: bare[1]! } : null;
}

const ESCAPES: Record<string, string> = {
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '\\': '\\textbackslash{}',
};
/** Escapes characters that are special in LaTeX; markup from the source (HTML/MathML tags) is dropped. */
export const escapeBibtex = (text: string) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[&%$#_{}~^\\]/g, (c) => ESCAPES[c]!);

/** Wraps words whose capitals must survive a bibliography style's lowercasing, e.g. {Bayesian}, {DNA}, {LaTeX}. */
export function protectCapitals(title: string) {
  return title
    .split(' ')
    .map((word, i) => {
      const core = /^([^A-Za-z0-9\\]*)(.*?)([^A-Za-z0-9}]*)$/.exec(word)!;
      const body = core[2]!;
      const capitals = (i === 0 ? body.slice(1) : body).replace(/\\[a-zA-Z]+/g, '');
      return /[A-Z]/.test(capitals) && body ? `${core[1]}{${body}}${core[3]}` : word;
    })
    .join(' ');
}

const ascii = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'from', 'by', 'at', 'is', 'are']);
/** Key in the form authorYEARfirstword, e.g. knuth1984literate. */
export function makeKey(family: string | undefined, year: string | undefined, title: string | undefined) {
  const word =
    (title ?? '')
      .replace(/<[^>]+>/g, '')
      .split(/\s+/)
      .map((w) => ascii(w).toLowerCase())
      .find((w) => w && !STOP.has(w)) ?? '';
  return `${ascii(family ?? '').toLowerCase() || 'anon'}${year ?? ''}${word}` || 'reference';
}

type Person = { family?: string; given?: string; name?: string };
const people = (list: Person[] | undefined) =>
  (list ?? [])
    .map((p) =>
      p.family
        ? `${escapeBibtex(p.family)}${p.given ? `, ${escapeBibtex(p.given)}` : ''}`
        : p.name
          ? `{${escapeBibtex(p.name)}}`
          : '',
    )
    .filter(Boolean)
    .join(' and ');
const TYPES: Record<string, string> = {
  'journal-article': 'article',
  'proceedings-article': 'inproceedings',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'book-chapter': 'incollection',
  'book-section': 'incollection',
  dissertation: 'phdthesis',
  report: 'techreport',
  'posted-content': 'misc',
};
const field = (fields: [string, string][], name: string, value: string | undefined | null) => {
  if (value) fields.push([name, value]);
};

/** A Crossref `message` object as a BibTeX entry. */
export function fromCrossref(work: any): BibEntry {
  const type = TYPES[String(work.type)] ?? 'misc';
  const title = Array.isArray(work.title) ? work.title[0] : work.title;
  const year =
    String(work.issued?.['date-parts']?.[0]?.[0] ?? work.published?.['date-parts']?.[0]?.[0] ?? '') || undefined;
  const container = Array.isArray(work['container-title']) ? work['container-title'][0] : work['container-title'];
  const fields: [string, string][] = [];
  field(fields, 'author', people(work.author));
  if (!work.author?.length) field(fields, 'editor', people(work.editor));
  field(fields, 'title', title ? protectCapitals(escapeBibtex(String(title))) : undefined);
  field(
    fields,
    type === 'article' ? 'journal' : type === 'inproceedings' || type === 'incollection' ? 'booktitle' : 'howpublished',
    container ? escapeBibtex(String(container)) : undefined,
  );
  field(fields, 'year', year);
  field(fields, 'volume', work.volume && String(work.volume));
  field(fields, 'number', work.issue && String(work.issue));
  field(fields, 'pages', work.page && String(work.page).replace(/\s*[-–]+\s*/, '--'));
  field(fields, 'publisher', type === 'article' ? undefined : work.publisher && escapeBibtex(String(work.publisher)));
  field(
    fields,
    type === 'phdthesis' ? 'school' : type === 'techreport' ? 'institution' : '',
    type === 'phdthesis' || type === 'techreport' ? work.publisher && escapeBibtex(String(work.publisher)) : undefined,
  );
  field(fields, 'doi', work.DOI && String(work.DOI));
  const first = work.author?.[0] ?? work.editor?.[0];
  return {
    type,
    key: makeKey(first?.family ?? first?.name, year, title && String(title)),
    fields: fields.filter(([name]) => name),
  };
}

const xml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
/** The first entry of an arXiv Atom response as a BibTeX entry; null when the id doesn't exist. */
export function fromArxiv(atom: string, id: string): BibEntry | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(atom)?.[1];
  const tag = (name: string) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry ?? '');
    return m ? xml(m[1]!).replace(/\s+/g, ' ').trim() : undefined;
  };
  const title = tag('title');
  if (!entry || !title || /<id>[^<]*\/api\/errors/.test(entry)) return null;
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => xml(m[1]!).trim());
  const person = (name: string) => {
    const parts = name.split(/\s+/);
    const family = parts.pop() ?? name;
    return parts.length ? `${escapeBibtex(family)}, ${escapeBibtex(parts.join(' '))}` : `{${escapeBibtex(family)}}`;
  };
  const year = tag('published')?.slice(0, 4);
  const fields: [string, string][] = [];
  field(fields, 'author', authors.map(person).join(' and '));
  field(fields, 'title', protectCapitals(escapeBibtex(title)));
  field(fields, 'year', year);
  field(fields, 'eprint', id);
  field(fields, 'archivePrefix', 'arXiv');
  field(fields, 'primaryClass', /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1]);
  field(fields, 'doi', tag('arxiv:doi'));
  field(fields, 'note', tag('arxiv:journal_ref') && escapeBibtex(tag('arxiv:journal_ref')!));
  return { type: 'misc', key: makeKey(authors[0]?.split(/\s+/).pop(), year, title), fields };
}

export const formatEntry = (entry: BibEntry) =>
  `@${entry.type}{${entry.key},\n${entry.fields.map(([name, value]) => `  ${name} = {${value}}`).join(',\n')}\n}`;

/** Citation keys defined in a .bib file (or in entry text the user edited). */
export const bibKeys = (bib: string) =>
  [...bib.matchAll(/@(\w+)\s*\{\s*([^,\s{}]+)\s*,/g)]
    .filter((m) => !/^(comment|string|preamble)$/i.test(m[1]!))
    .map((m) => m[2]!);

/** Appends entries to a .bib file's text with one blank line between entries. */
export const appendEntries = (bib: string, entries: string[]) =>
  `${bib.trimEnd()}${bib.trim() ? '\n\n' : ''}${entries.map((e) => e.trim()).join('\n\n')}\n`;
