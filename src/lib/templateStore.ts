// The template gallery's data. Every folder in /templates is one template: a metadata.json, the project's files and
// a thumbnail.png of its first page. Adding a template is adding a folder; nothing here needs to change.
import { arrayBufferToBase64, type ProjectFile } from './project';

export type TemplateMeta = {
  id: string; name: string; description: string; category: string; tags: string[];
  mainFile: string; engine: string; order: number; thumbnail?: string;
};
type RawMeta = Partial<Omit<TemplateMeta, 'id' | 'thumbnail'>>;

const metadata = import.meta.glob('/templates/*/metadata.json', { eager: true, import: 'default' }) as Record<string, RawMeta>;
const thumbnails = import.meta.glob('/templates/*/thumbnail.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
// Files are loaded only when a template is used, so the gallery itself stays small.
const textFiles = import.meta.glob(['/templates/*/**/*.{tex,bib,cls,bst,sty,txt}', '!/templates/_*/**'], { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const binaryFiles = import.meta.glob(['/templates/*/**/*.{png,jpg,jpeg,pdf,eps}', '!/templates/*/thumbnail.png', '!/templates/_*/**'], { query: '?url', import: 'default' }) as Record<string, () => Promise<string>>;

const idOf = (path: string) => path.split('/')[2]!;
const nameIn = (path: string) => path.split('/').slice(3).join('/');

export const templates: TemplateMeta[] = Object.entries(metadata)
  .map(([path, raw]) => {
    const id = idOf(path);
    return {
      id, name: raw.name ?? id, description: raw.description ?? '', category: raw.category ?? 'Other', tags: raw.tags ?? [],
      mainFile: raw.mainFile ?? 'main.tex', engine: raw.engine ?? 'pdflatex', order: raw.order ?? 999,
      thumbnail: thumbnails[`/templates/${id}/thumbnail.png`],
    };
  })
  .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

/** Categories in the order templates first use them, for the filter buttons. */
export const templateCategories = (list: TemplateMeta[]) => [...new Set(list.map(t => t.category))];

/** Templates in a category ('' for all) whose name, description or tags contain every word of the search. */
export function filterTemplates(list: TemplateMeta[], category: string, search: string) {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter(t => {
    if (category && t.category !== category) return false;
    const text = `${t.name} ${t.description} ${t.category} ${t.tags.join(' ')}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Project files in tree order: the main file, then the rest by name, with an entry for every folder. */
export function orderTemplateFiles(files: ProjectFile[], mainFile: string): ProjectFile[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.name.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(`${parts.slice(0, i).join('/')}/`);
  }
  const rank = (name: string) => name === mainFile ? 0 : name.includes('/') ? 2 : 1;
  const all = [...files, ...[...folders].map(name => ({ name, content: '' }))];
  return all.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

/** Loads a template's files (text as text, images as base64), ready to become a project. */
export async function loadTemplateFiles(id: string): Promise<ProjectFile[]> {
  const prefix = `/templates/${id}/`;
  const texts = Object.entries(textFiles).filter(([path]) => path.startsWith(prefix)).map(async ([path, load]): Promise<ProjectFile> => ({ name: nameIn(path), content: await load() }));
  const binaries = Object.entries(binaryFiles).filter(([path]) => path.startsWith(prefix)).map(async ([path, load]): Promise<ProjectFile> => {
    const response = await fetch(await load());
    if (!response.ok) throw new Error(`Could not load ${nameIn(path)}`);
    return { name: nameIn(path), content: arrayBufferToBase64(await response.arrayBuffer()), encoding: 'base64' };
  });
  const files = await Promise.all([...texts, ...binaries]);
  if (!files.length) throw new Error('This template has no files.');
  const meta = templates.find(t => t.id === id);
  return orderTemplateFiles(files, meta?.mainFile ?? 'main.tex');
}
