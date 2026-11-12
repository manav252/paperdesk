# PaperDesk

PaperDesk is a LaTeX editor that runs in the browser. You get a project dashboard and a three-pane editor (file tree,
source, PDF preview), and documents are compiled with a full TeX Live installation. Projects can be shared and edited
together in real time.

Live site: https://paperdesk-b88a49.gitlab.io

## Screenshots

_Add screenshots of the dashboard, the editor and the template gallery to `docs/screenshots/` and link them here._

## Features

**Editing and compiling**
- Monaco editor with LaTeX completion, find and replace, an outline, a symbol palette, spell check, and optional Vim
  or Emacs key bindings.
- pdfLaTeX, XeLaTeX and LuaLaTeX through `latexmk`, with BibTeX and Biber. Recompiles reuse the previous build.
- Continuous PDF preview with zoom, search and download. Double-click the PDF to jump to the source, or sync the
  other way from the editor.
- Errors and warnings listed with file and line, with plain-language hints for common mistakes.
- Word count, light and dark themes, and a layout that works on phones.

**Projects**
- Template gallery with complete sample documents: IEEE and Springer papers, article, CV, report, Beamer slides,
  cover letter and homework.
- ZIP import and export, image upload with conversion of formats LaTeX cannot include.
- Accounts with an emailed sign-in link or Google. Without an account, projects are kept under a key stored in the
  browser.
- Sharing with owner, editor and viewer roles through invite links, real-time co-editing with visible cursors, and
  per-file history with restore.

**Writing a paper**
- Add a citation from a DOI or arXiv ID; the BibTeX entry is written for you.
- Paste or drag an image into the editor to get a figure block with the cursor in the caption.
- "Check before submitting" finds undefined references, missing and unused files, fonts that are not embedded and
  more, and exports an arXiv ZIP, a journal ZIP or a single flattened `.tex` file.
- An optional assistant panel that explains compile errors and suggests fixes, which are applied only when you
  accept them.

## Tech stack

| Layer | Tools |
| --- | --- |
| Web app | React, TypeScript, Vite, Monaco Editor, PDF.js, Yjs |
| API | Node.js, Express, socket.io |
| Compiling | TeX Live with `latexmk`; a Docker container per compile locally |
| Storage | Files on disk locally; Postgres (Neon) and Cloudflare R2 in production |
| Sign-in | Supabase Auth |
| Tests | Vitest, Playwright |
| Hosting | GitLab Pages for the web app, Render for the API |

## Prerequisites

- Node.js 20 or newer
- [Docker Desktop](https://docs.docker.com/get-docker/), for compiling locally
- About 10 GB of free disk space for the TeX Live compiler image

## Install and run

```sh
git clone https://github.com/manav252/paperdesk.git
cd paperdesk
npm install
npm run dev:all
```

`dev:all` checks that Docker is running, builds the `paperdesk-texlive` compiler image if it is missing (the first
build downloads TeX Live and takes a while), then starts the API on http://localhost:3001 and the editor on
http://localhost:5173. Open the editor, pick a template and press **Recompile**.

| Command | What it does |
| --- | --- |
| `npm run dev:all` | Compiler image check, API and editor |
| `npm run dev:all -- --no-docker` | API and editor without the Docker checks |
| `npm start` | API and editor |
| `npm run dev` / `npm run server` | Editor only / API only |
| `npm run compiler:build` | Build the compiler image |
| `npm run build` / `npm run preview` | Production build / serve it locally |
| `npm run templates:build` | Regenerate template figures and thumbnails |

## Environment variables

Copy `.env.example` to `.env` for local settings. Nothing is required for local development; the defaults store
projects on disk and compile in Docker. Never commit `.env`, and never put a secret in a `VITE_` variable: those are
compiled into the public web app.

| Variable | Purpose |
| --- | --- |
| `PORT`, `PAPERDESK_DATA` | API port and the folder for projects stored on disk |
| `COMPILE_MODE`, `LATEX_DOCKER_IMAGE` | `docker` (default) or `native`; the compiler image name |
| `COMPILE_TIMEOUT_MS`, `MAX_COMPILE_TIMEOUT_MS`, `COMPILE_MEMORY_MB`, `COMPILE_WORKSPACES` | Compile limits |
| `MAX_PROJECT_BYTES` | Largest project the API accepts |
| `DATABASE_URL`, `R2_*` | Postgres and object storage; set both to store projects in the cloud |
| `PAPERDESK_CORS_ORIGINS`, `TRUST_PROXY` | Needed when the web app and API are on different hosts |
| `SUPABASE_URL`, `SUPABASE_JWT_SECRET` | Sign-in; leave empty to run without accounts |
| `CROSSREF_MAILTO` | Contact address sent with citation lookups |
| `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_RATE_LIMIT`, `ASSISTANT_MAX_REQUEST_KB` | The assistant panel; without a key it shows "not configured" |
| `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Build-time settings for the web app |

`.env.example` documents each one. Production setup is described in [docs/deployment.md](docs/deployment.md).

## Tests

```sh
npm run check            # format check, lint, typecheck, unit tests, production build and browser tests
npm run format           # format the code with Prettier (format:check only reports)
npm run lint
npm run typecheck
npm test                 # unit tests
npm run test:e2e         # browser tests (run `npx playwright install chromium` once first)
npm run test:compile     # compiles every fixture and template with the real compiler; needs Docker
npm run test:templates   # the templates only
npm run test:compile:api # the same compiles inside the production API image
```

The browser tests run on desktop and phone sizes in light and dark themes. Tests for sharing and co-editing need
Postgres and an S3-compatible store and are skipped unless `E2E_CLOUD_STORAGE=1` is set.

## Project structure

```
src/            web app (React components, editor, PDF viewer)
src/lib/        logic shared by the web app and the API, with unit tests
server/         API: index.ts is the entry point (routes, compiling, live updates); the other files are its
                modules for storage, auth, sharing, co-editing, citations and the assistant
templates/      template gallery, one folder per template
test/e2e/       browser tests
test/fixtures/  LaTeX projects and files used by the tests
scripts/        development, build and test scripts
docs/           architecture, deployment, roadmap, known issues
Dockerfile.compiler   TeX Live image used for local compiles
Dockerfile.api        production API image
render.yaml, .gitlab-ci.yml, .github/workflows/   deployment
```

More detail is in [docs/architecture.md](docs/architecture.md). Planned work is in
[docs/roadmap.md](docs/roadmap.md) and current limits in [docs/known-issues.md](docs/known-issues.md).

## Contributing

1. Create a branch from `main`.
2. Make the change, with tests for new behaviour. To add a template, follow `templates/README.md`.
3. Run `npm run check`, and `npm run test:compile` if the change touches compiling or templates.
4. Open a pull request that says what changed and how you tested it.

Bug reports are welcome as issues; include the steps, what you expected and what happened, and the compile log if
there is one.

## License

[MIT](LICENSE). The Springer Nature class and reference style in `templates/springer-journal/` are distributed under
the LaTeX Project Public License; see `SOURCE.txt` in that folder.
