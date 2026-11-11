import { formatEntry, fromArxiv, fromCrossref, parseIdentifier, type BibEntry } from '../src/lib/bibtex';
import type { Kv } from './kv';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export type CitationResult = { input: string; ok: true; kind: 'doi' | 'arxiv'; id: string; key: string; bibtex: string } | { input: string; ok: false; code: 'invalid' | 'not_found' | 'network'; error: string };

/**
 * Looks up DOIs on Crossref and arXiv ids on arXiv, from the server so the browser needs no third-party access.
 * Crossref asks API users to identify themselves: CROSSREF_MAILTO is sent in the User-Agent. Results are kept 7 days.
 */
export function createCitationLookup(kv: Kv, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
  const crossref = (env.CROSSREF_API_URL ?? 'https://api.crossref.org').replace(/\/+$/, '');
  const arxiv = env.ARXIV_API_URL ?? 'https://export.arxiv.org/api/query';
  const mailto = (env.CROSSREF_MAILTO ?? '').trim();
  const headers = { 'User-Agent': `PaperDesk/1.0 (LaTeX editor${mailto ? `; mailto:${mailto}` : ''})`, Accept: 'application/json, application/atom+xml' };

  async function fetchEntry(kind: 'doi' | 'arxiv', id: string): Promise<BibEntry | null> {
    const url = kind === 'doi' ? `${crossref}/works/${encodeURIComponent(id)}${mailto ? `?mailto=${encodeURIComponent(mailto)}` : ''}` : `${arxiv}?id_list=${encodeURIComponent(id)}&max_results=1`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${kind === 'doi' ? 'Crossref' : 'arXiv'} answered ${response.status}`);
    if (kind === 'arxiv') return fromArxiv(await response.text(), id);
    const body = await response.json() as { message?: unknown };
    return body.message ? fromCrossref(body.message) : null;
  }

  return async function lookup(input: string): Promise<CitationResult> {
    const parsed = parseIdentifier(input);
    if (!parsed) return { input, ok: false, code: 'invalid', error: 'This isn’t a DOI, a doi.org link or an arXiv ID.' };
    const cacheKey = `${parsed.kind}:${parsed.id}`;
    try {
      const cached = await kv.get<BibEntry>('citations', cacheKey).catch(() => null);
      let entry = cached && Date.now() - cached.updated < WEEK_MS ? cached.value : null;
      if (!entry) {
        entry = await fetchEntry(parsed.kind, parsed.id);
        if (!entry) return { input, ok: false, code: 'not_found', error: parsed.kind === 'doi' ? `No record was found for DOI ${parsed.id}.` : `arXiv has no paper with the ID ${parsed.id}.` };
        await kv.set('citations', cacheKey, entry).catch(() => undefined);
      }
      return { input, ok: true, kind: parsed.kind, id: parsed.id, key: entry.key, bibtex: formatEntry(entry) };
    } catch {
      return { input, ok: false, code: 'network', error: `${parsed.kind === 'doi' ? 'Crossref' : 'arXiv'} couldn’t be reached. Try again in a moment.` };
    }
  };
}
