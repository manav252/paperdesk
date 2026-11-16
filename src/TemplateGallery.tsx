import { useMemo, useState } from 'react';
import { FileText, Search, X } from 'lucide-react';
import { filterTemplates, templateCategories, type TemplateMeta } from './lib/templateStore';

/** The template gallery: cards with a preview of the first page, filtered by category and search. */
export function TemplateGallery({
  templates,
  busyId,
  onUse,
}: {
  templates: TemplateMeta[];
  busyId: string;
  onUse: (template: TemplateMeta) => void;
}) {
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [language, setLanguage] = useState('');
  const categories = useMemo(() => templateCategories(templates), [templates]);
  const shown = useMemo(
    () => filterTemplates(templates, category, search, language),
    [templates, category, search, language],
  );

  return (
    <section className="template-gallery" aria-label="Templates">
      <div className="template-tools">
        <div className="template-filters" role="group" aria-label="Template category">
          {['', ...categories].map((name) => (
            <button
              type="button"
              key={name || 'all'}
              className={`template-filter ${category === name ? 'active' : ''}`}
              aria-pressed={category === name}
              onClick={() => setCategory(name)}
            >
              {name || 'All'}
              <span className="template-filter-count">
                {name ? templates.filter((t) => t.category === name).length : templates.length}
              </span>
            </button>
          ))}
        </div>
        <div className="segmented template-language" role="radiogroup" aria-label="Template language">
          {[
            ['', 'All'],
            ['latex', 'LaTeX'],
            ['typst', 'Typst'],
          ].map(([value, label]) => (
            <button
              type="button"
              role="radio"
              key={value || 'all'}
              aria-checked={language === value}
              className={language === value ? 'on' : ''}
              onClick={() => setLanguage(value!)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search-box template-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates…"
            aria-label="Search templates"
          />
          {search && (
            <button
              type="button"
              className="clear-search"
              aria-label="Clear template search"
              onClick={() => setSearch('')}
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="template-empty" role="status">
          No templates match{search ? ` “${search}”` : ''}
          {category ? ` in ${category}` : ''}.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setSearch('');
              setCategory('');
              setLanguage('');
            }}
          >
            Show all templates
          </button>
        </p>
      ) : (
        <div className="template-grid">
          {shown.map((template) => (
            <button
              type="button"
              className="template-card"
              key={template.id}
              data-template={template.id}
              disabled={!!busyId}
              aria-busy={busyId === template.id}
              onClick={() => onUse(template)}
            >
              <div className={`template-thumb ${template.category === 'Presentation' ? 'wide' : ''}`}>
                {template.thumbnail ? <img src={template.thumbnail} alt="" loading="lazy" /> : <FileText size={28} />}
              </div>
              <div className="template-body">
                <strong>{template.name}</strong>
                <span>{template.description}</span>
                <div className="template-tags">
                  <i className={`template-lang ${template.language}`}>
                    {template.language === 'typst' ? 'Typst' : 'LaTeX'}
                  </i>
                  {template.tags.map((tag) => (
                    <i key={tag}>{tag}</i>
                  ))}
                </div>
                <em>{busyId === template.id ? 'Creating project…' : 'Use this template'}</em>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
