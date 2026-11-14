// Stand-ins for the outside services the API calls (Crossref, arXiv, the email provider, GitHub), so browser tests never use the network.
import http from 'node:http';
import crypto from 'node:crypto';

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
const mail = [];

// A small GitHub: OAuth, repositories and the git data API, kept in memory. `/github/test/*` lets tests look
// inside a repository and commit to it as if someone had pushed from elsewhere.
const GH_TOKEN = 'gho_test_token';
const github = { repos: new Map(), revoked: 0 };
const sha = (text) => crypto.createHash('sha1').update(text).digest('hex');
const blobSha = (buffer) =>
  crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer]))
    .digest('hex');
function commitTo(repo, files, message, author = 'octo-test') {
  const tree = sha(JSON.stringify(Object.entries(files).sort()));
  repo.trees.set(tree, files);
  const id = sha(`${tree}${message}${repo.commits.length}`);
  repo.commits.push({ sha: id, tree, message, author });
  repo.head = id;
  return id;
}
function addBlob(repo, buffer) {
  const id = blobSha(buffer);
  repo.blobs.set(id, buffer);
  return id;
}
function makeRepo(fullName, isPrivate, init) {
  const repo = { fullName, private: isPrivate, blobs: new Map(), trees: new Map(), commits: [], head: null };
  github.repos.set(fullName, repo);
  if (init) commitTo(repo, { 'README.md': addBlob(repo, Buffer.from(`# ${fullName}\n`)) }, 'Initial commit');
  return repo;
}
const headFiles = (repo) => (repo.head ? repo.trees.get(repo.commits.find((c) => c.sha === repo.head).tree) : {});
const repoInfo = (repo) => ({
  full_name: repo.fullName,
  private: repo.private,
  default_branch: 'main',
  html_url: `https://github.example/${repo.fullName}`,
  permissions: { push: true },
});
function githubApi(req, res, url, body, json) {
  const path = url.pathname.slice('/github/api'.length);
  if (req.method === 'DELETE' && /^\/applications\/[^/]+\/grant$/.test(path)) {
    github.revoked++;
    res.writeHead(204);
    return res.end();
  }
  if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) return json(401, { message: 'Bad credentials' });
  if (path === '/user') return json(200, { login: 'octo-test' });
  if (path === '/user/repos' && req.method === 'GET') return json(200, [...github.repos.values()].map(repoInfo));
  if (path === '/user/repos' && req.method === 'POST') {
    const name = `octo-test/${body.name}`;
    if (github.repos.has(name)) return json(422, { message: 'name already exists on this account' });
    return json(201, repoInfo(makeRepo(name, !!body.private, !!body.auto_init)));
  }
  const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
  const repo = match && github.repos.get(match[1]);
  if (!repo) return json(404, { message: 'Not Found' });
  const sub = match[2] ?? '';
  if (!sub) return json(200, repoInfo(repo));
  if (sub === '/git/ref/heads/main')
    return repo.head ? json(200, { object: { sha: repo.head } }) : json(409, { message: 'Git Repository is empty.' });
  let m;
  if ((m = /^\/git\/commits\/(\w+)$/.exec(sub))) {
    const commit = repo.commits.find((c) => c.sha === m[1]);
    return commit ? json(200, { sha: commit.sha, tree: { sha: commit.tree } }) : json(404, { message: 'Not Found' });
  }
  if ((m = /^\/git\/trees\/(\w+)$/.exec(sub))) {
    const files = repo.trees.get(m[1]);
    if (!files) return json(404, { message: 'Not Found' });
    return json(200, {
      truncated: false,
      tree: Object.entries(files).map(([p, id]) => ({ path: p, type: 'blob', sha: id })),
    });
  }
  if ((m = /^\/git\/blobs\/(\w+)$/.exec(sub))) {
    const blob = repo.blobs.get(m[1]);
    return blob
      ? json(200, { content: blob.toString('base64'), encoding: 'base64' })
      : json(404, { message: 'Not Found' });
  }
  if (sub === '/git/blobs' && req.method === 'POST')
    return json(201, { sha: addBlob(repo, Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
  if (sub === '/git/trees' && req.method === 'POST') {
    const files = { ...(body.base_tree ? repo.trees.get(body.base_tree) : {}) };
    for (const entry of body.tree) {
      if (entry.sha === null) delete files[entry.path];
      else files[entry.path] = entry.sha;
    }
    const id = sha(JSON.stringify(Object.entries(files).sort()));
    repo.trees.set(id, files);
    return json(201, { sha: id });
  }
  if (sub === '/git/commits' && req.method === 'POST') {
    const id = sha(`${body.tree}${body.message}${repo.commits.length}`);
    repo.commits.push({
      sha: id,
      tree: body.tree,
      message: body.message,
      author: body.author?.name ?? 'octo-test',
      // True if the caller named an author or committer instead of leaving it to the signed-in account.
      namedAuthor: !!(body.author || body.committer),
    });
    return json(201, { sha: id });
  }
  if (sub === '/git/refs/heads/main' && req.method === 'PATCH') {
    const commit = repo.commits.find((c) => c.sha === body.sha);
    if (!commit) return json(422, { message: 'Object does not exist' });
    repo.head = body.sha;
    return json(200, { object: { sha: repo.head } });
  }
  if ((m = /^\/contents\/(.+)$/.exec(sub)) && req.method === 'PUT') {
    const files = { ...headFiles(repo), [m[1]]: addBlob(repo, Buffer.from(body.content, 'base64')) };
    return json(201, { commit: { sha: commitTo(repo, files, body.message) } });
  }
  json(404, { message: 'Not Found' });
}
function githubRoutes(req, res, url, body, json) {
  if (url.pathname === '/github/login/oauth/authorize') {
    // The person "approves" at once and is sent back to the API's callback, as GitHub would.
    res.writeHead(302, {
      Location: `http://127.0.0.1:3002/api/github/callback?code=test-code&state=${url.searchParams.get('state')}`,
    });
    return res.end();
  }
  if (url.pathname === '/github/login/oauth/access_token')
    return json(200, body.code === 'test-code' ? { access_token: GH_TOKEN, scope: 'repo' } : { error: 'bad_code' });
  if (url.pathname === '/github/test/reset') {
    github.repos.clear();
    github.revoked = 0;
    return json(200, { ok: true });
  }
  if (url.pathname === '/github/test/repo') {
    const repo = github.repos.get(url.searchParams.get('repo'));
    if (!repo) return json(200, { revoked: github.revoked, repos: [...github.repos.keys()] });
    const files = Object.fromEntries(
      Object.entries(headFiles(repo)).map(([p, id]) => [p, repo.blobs.get(id).toString('utf8')]),
    );
    return json(200, {
      files,
      commits: repo.commits.map((c) => ({ message: c.message, author: c.author, namedAuthor: !!c.namedAuthor })),
    });
  }
  if (url.pathname === '/github/test/commit') {
    const repo = github.repos.get(body.repo) ?? makeRepo(body.repo, true, false);
    const files = { ...headFiles(repo) };
    for (const [p, text] of Object.entries(body.files ?? {})) files[p] = addBlob(repo, Buffer.from(text));
    for (const p of body.remove ?? []) delete files[p];
    return json(200, { sha: commitTo(repo, files, body.message ?? 'Change made on GitHub', 'someone-else') });
  }
  return githubApi(req, res, url, body, json);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, agent: req.headers['user-agent'] });
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/github/')) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      return req.on('end', () => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          /* not JSON */
        }
        githubRoutes(req, res, url, body, json);
      });
    }
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/requests') return json(200, requests);
    if (url.pathname === '/mail/sent') return json(200, mail);
    if (url.pathname === '/mail' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      return req.on('end', () => {
        mail.push({ key: req.headers['api-key'], ...JSON.parse(body) });
        json(201, { messageId: 'test' });
      });
    }
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
