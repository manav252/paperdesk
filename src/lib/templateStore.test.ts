import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSubmission, type SubmissionFile } from './submission';
import { filterTemplates, loadTemplateFiles, orderTemplateFiles, templateCategories, templates } from './templateStore';

const ROOT = path.resolve('templates');
const folders = readdirSync(ROOT).filter(
  (name) => !name.startsWith('_') && statSync(path.join(ROOT, name)).isDirectory(),
);
const BINARY = /\.(png|jpe?g|pdf|eps)$/i;
/** A template's files as the editor would hold them, read straight from disk. */
function filesOf(id: string, rel = ''): SubmissionFile[] {
  return readdirSync(path.join(ROOT, id, rel)).flatMap((name) => {
    const file = rel ? `${rel}/${name}` : name;
    if (statSync(path.join(ROOT, id, file)).isDirectory()) return filesOf(id, file);
    if (file === 'metadata.json' || file === 'thumbnail.png') return [];
    const bytes = readFileSync(path.join(ROOT, id, file));
    return [
      BINARY.test(file)
        ? { name: file, content: bytes.toString('base64'), encoding: 'base64' }
        : { name: file, content: bytes.toString('utf8') },
    ];
  });
}

describe('template gallery data', () => {
  it('lists every folder in templates/ with complete metadata and a thumbnail', () => {
    expect(templates.map((t) => t.id).sort()).toEqual([...folders].sort());
    expect(templates.length).toBeGreaterThanOrEqual(9);
    for (const template of templates) {
      expect(template.name.length, template.id).toBeGreaterThan(3);
      expect(template.description.length, template.id).toBeGreaterThan(30);
      expect(template.tags, template.id).toContain(template.category);
      expect(template.thumbnail, template.id).toBeTruthy();
      expect(statSync(path.join(ROOT, template.id, 'thumbnail.png')).size, template.id).toBeLessThan(80_000);
    }
    expect(templateCategories(templates)).toEqual(
      expect.arrayContaining(['Paper', 'CV', 'Report', 'Presentation', 'Letter']),
    );
    expect(templates.map((t) => t.order)).toEqual([...templates.map((t) => t.order)].sort((a, b) => a - b));
  });

  it.each(folders)('%s is a complete project: nothing missing, undefined or unused', (id) => {
    const meta = JSON.parse(readFileSync(path.join(ROOT, id, 'metadata.json'), 'utf8'));
    const files = filesOf(id);
    expect(files.some((f) => f.name === meta.mainFile)).toBe(true);
    // The same checks as "Check before submitting": missing files, undefined references and citations, unused files.
    const problems = checkSubmission(files, meta.mainFile, { success: true, errors: [], warnings: [] }, []).filter(
      (issue) => !(issue.kind === 'unused-file' && /^(SOURCE\.txt|.*\.(cls|bst))$/.test(issue.file ?? '')),
    );
    expect(problems.map((p) => `${p.kind}: ${p.message}`)).toEqual([]);
    // Sample text, not filler.
    const text = files
      .filter((f) => f.encoding !== 'base64')
      .map((f) => f.content)
      .join('\n');
    expect(text).not.toMatch(/lorem ipsum|your title here/i);
    expect(text.length).toBeGreaterThan(2500);
  });

  it("loads a template's text files in tree order", async () => {
    const files = await loadTemplateFiles('homework');
    expect(files.map((f) => f.name)).toEqual(['main.tex']);
    expect(files[0]!.content).toBe(readFileSync(path.join(ROOT, 'homework', 'main.tex'), 'utf8'));
    await expect(loadTemplateFiles('no-such-template')).rejects.toThrow('no files');
  });

  it('orders files with the main file first and an entry for each folder', () => {
    const ordered = orderTemplateFiles(
      [
        { name: 'sections/b.tex', content: '' },
        { name: 'references.bib', content: '' },
        { name: 'figures/deep/x.png', content: '', encoding: 'base64' },
        { name: 'main.tex', content: '' },
      ],
      'main.tex',
    );
    expect(ordered.map((f) => f.name)).toEqual([
      'main.tex',
      'references.bib',
      'figures/',
      'figures/deep/',
      'figures/deep/x.png',
      'sections/',
      'sections/b.tex',
    ]);
  });

  it('filters by category and by every search word', () => {
    expect(filterTemplates(templates, 'CV', '').map((t) => t.id)).toEqual(['cv']);
    expect(filterTemplates(templates, '', 'springer journal').map((t) => t.id)).toEqual(['springer-journal']);
    expect(filterTemplates(templates, '', 'SLIDES').map((t) => t.id)).toEqual(['beamer']);
    expect(filterTemplates(templates, 'Paper', 'slides')).toEqual([]);
    expect(filterTemplates(templates, '', '   ').length).toBe(templates.length);
  });
});
