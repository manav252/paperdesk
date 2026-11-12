# Architecture

PaperDesk is a browser-based LaTeX editor: a project dashboard, then a three-pane editor with the file tree, the
source and the compiled PDF. This document describes how the parts fit together and why some of them are built the
way they are.

## Overview

```
Browser (React, Monaco, PDF.js)
   │  HTTPS /api, WebSocket (socket.io)
   ▼
API server (Express)  ──►  LaTeX compiler (Docker container locally, sandboxed TeX on the host in production)
   │
   ├── Postgres (Neon): projects, sharing, history, key-value data
   └── Object storage (Cloudflare R2): file contents, compiled PDFs
```

| Part         | Where                                           | Notes                                                                                                   |
| ------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Web app      | `src/`                                          | Vite, React and TypeScript. Monaco is the editor, PDF.js renders the preview.                           |
| API          | `server/` (entry point `server/index.ts`)       | Express 5 with socket.io on the same HTTP server.                                                       |
| Shared logic | `src/lib/`                                      | Pure functions used by both the web app and the API (log parsing, SyncTeX, patches, submission checks). |
| Templates    | `templates/`                                    | One folder per template; see `templates/README.md`.                                                     |
| Tests        | `src/**/*.test.ts`, `server/*.test.ts`, `test/` | Unit tests sit next to the code; browser tests and compile fixtures are in `test/`.                     |

Without a database the API stores projects as plain files under `PAPERDESK_DATA`, which is what local development
uses. With `DATABASE_URL` and the `R2_*` variables set it uses Postgres and object storage.

## Compiling

- The browser sends the files that changed since the last compile; the API keeps a warm build folder per project so
  `latexmk` only repeats the passes whose inputs changed. When a previous compile succeeded and only text changed, a
  single engine pass is tried first and `latexmk` runs only if the auxiliary files changed.
- Locally each compile runs in a throwaway Docker container with no network, a read-only root, and CPU, memory and
  process limits. Render's free web services cannot run Docker, so in production TeX runs on the host as an
  unprivileged user with resource limits (`COMPILE_MODE=native`).
- One compile runs at a time. A newer compile of the same project replaces a running one, which answers HTTP 410.
- The log is parsed into errors and warnings with file and line (`src/lib/latexLog.ts`), with plain-language hints for
  the mistakes newcomers make most.
- SyncTeX maps between source lines and PDF positions (`src/lib/synctex.ts`). PDF.js reports positions from the
  bottom-left of the page and SyncTeX from the top-left, so coordinates are flipped with the page box.

## Projects and saving

- Projects are mirrored in the browser's local storage, so the editor keeps working while the API is unreachable.
- Autosave sends only the files that changed, each with the hash of the version it was edited from
  (`src/lib/filePatch.ts`). The server refuses a file that someone else changed in the meantime and answers 409.
- The server reads, merges and writes a project under one per-project lock. Without it, two saves arriving together
  could each write back a file list that lacked the other's new file.

## Accounts, sharing and history

- Supabase Auth handles sign-in (email link and Google). It is used for sign-in only: the API verifies the token and
  projects stay in Postgres and object storage. A signed-in owner is `user:<id>`; without an account the browser
  uses a random key, and the projects under that key are moved to the account on first sign-in.
- A shared project has roles (owner, editor, viewer) and invite links (`server/sharing.ts`). Access is denied by
  default: `roleAllows` lists what each role may do. Viewers compile the saved project, not files they send.
- Each save records per-file versions with their author, so the history panel can show and restore earlier text.

## Real-time editing

Shared projects are edited through Yjs. The API holds one document per open project (`server/collab.ts`), relays
updates and cursors over socket.io, checks the role on every edit, and saves the text shortly after typing stops.
Files added or changed through the normal save path are mirrored into the live document.

## Research features

- **Citations by DOI or arXiv ID** (`server/citations.ts`, `src/lib/bibtex.ts`): looked up at Crossref and arXiv,
  cached, and written to the project's `.bib` file with a generated key.
- **Figures** (`src/figures.ts`, `src/lib/figure.ts`): pasted or dropped images are stored in `figures/`, converted
  to PNG when LaTeX cannot include the format, scaled down when very large, and inserted as a figure block.
- **Check before submitting** (`src/lib/submission.ts`): static checks on the project and the latest compile, and
  ZIP exports that the server compiles on their own in an empty folder before sending them.

## Decisions worth knowing

- **Monaco, not CodeMirror.** Key bindings, spell-check markers and completion are built on Monaco's APIs.
- **Postgres and object storage for projects, Supabase for sign-in only.** The project data stays on services whose
  free tiers do not delete inactive databases.
- **Fonts are checked in the browser.** PDF.js reports whether a font's file is embedded, so the submission check
  needs no extra tool on the server.
- **Templates are folders, not code.** The gallery is built from `templates/*/metadata.json` at build time and a
  template's files are loaded only when it is used.
