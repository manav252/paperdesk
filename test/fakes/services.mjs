// Stand-ins for the outside services the API calls (Crossref, arXiv), so browser tests never use the network.
import http from 'node:http';

const works = {
  '10.1038/s41586-020-2649-2': {
    type: 'journal-article',
    title: ['Array programming with NumPy'],
    author: [
      { family: 'Harris', given: 'Charles R.' },
      { family: 'Millman', given: 'K. Jarrod' },
    ],
    'container-title': ['Nature'],
    issued: { 'date-parts': [[2020]] },
    volume: '585',
    issue: '7825',
    page: '357-362',
    DOI: '10.1038/s41586-020-2649-2',
  },
  '10.1000/existing': {
    type: 'journal-article',
    title: ['Literate programming'],
    author: [{ family: 'Knuth', given: 'Donald E.' }],
    'container-title': ['The Computer Journal'],
    issued: { 'date-parts': [[1984]] },
    DOI: '10.1000/existing',
  },
};
const arxiv = {
  1706.03762:
    '<feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/1706.03762v5</id><published>2017-06-12T17:57:34Z</published><title>Attention Is All You Need</title><author><name>Ashish Vaswani</name></author><arxiv:primary_category term="cs.CL"/></entry></feed>',
};
export const requests = [];

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, agent: req.headers['user-agent'] });
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/requests') return json(200, requests);
    if (url.pathname.startsWith('/crossref/works/')) {
      const doi = decodeURIComponent(url.pathname.slice('/crossref/works/'.length));
      return works[doi] ? json(200, { status: 'ok', message: works[doi] }) : json(404, { status: 'error' });
    }
    if (url.pathname === '/arxiv') {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      return res.end(arxiv[url.searchParams.get('id_list')] ?? '<feed></feed>');
    }
    json(404, { error: 'unknown fake route' });
  })
  .listen(Number(process.env.FAKES_PORT ?? 3997), '127.0.0.1');
