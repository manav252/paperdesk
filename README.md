# PaperDesk

An independent LaTeX editor with an Overleaf-style workflow: a project dashboard, then a three-pane editor (file tree, LaTeX source, PDF preview). PDFs are compiled with full TeX Live (pdfLaTeX, XeLaTeX or LuaLaTeX, with BibTeX), each time in a throwaway Docker container.

## Quick start (development)

Requirements: Node.js 20+ and [Docker Desktop](https://docs.docker.com/get-docker/).

```sh
npm install
npm run dev:all
```

`dev:all` starts everything:

1. **Compile service.** It checks that Docker is running (on macOS it starts Docker Desktop if needed) and builds the `paperdesk-texlive` compiler image if it's missing. The first build downloads TeX Live, about 5 GB, and takes a while.
2. **API** on http://localhost:3001. It restarts when `server.ts` changes.
3. **Editor** on http://localhost:5173. The Vite dev server proxies `/api` to the API.

Open http://localhost:5173. Press **Recompile** (`⌘/Ctrl+Enter`) to build the PDF.

| Command | What it does |
| --- | --- |
| `npm run dev:all` | Compile service + API + editor (use this) |
| `npm run dev:all -- --no-docker` | API + editor without the Docker checks |
| `npm start` | API + editor, no Docker checks |
| `npm run dev` / `npm run server` | Editor only / API only |
| `npm run compiler:build` | (Re)build the compiler image |

## Compiling

- Choose the engine from the arrow next to **Recompile**, or in **Settings**. `latexmk` runs as many passes as the document needs, including BibTeX.
- **Errors.** When compilation fails, the banner shows the first error with **Go to error**. **Logs** lists every error and warning with its file and line; click one to open that file at that line. Problem lines are also underlined in the editor.
- **Isolation.** Each compile runs in a new container with no network, a read-only root filesystem, CPU, memory and process limits, and a 2-minute timeout. The container runs as your user and is removed afterwards. No TeX runs on the host.
- **Main file.** The main document must be `main.tex` at the project root.

### Compile test suite

`test/fixtures/compile/` contains the reference projects:

- a plain article
- the IEEE conference, Springer, article, report, Beamer and CV gallery starters
- an IEEEtran paper with BibTeX and a biblatex/Biber project
- a Springer Nature `sn-jnl` paper with figures
- a project with subfolders
- a deliberately broken project

This compiles every one with all three engines through the real API and checks the PDF, or the reported error location:

```sh
npm run test:compile            # all fixtures
npm run test:compile -- broken  # one fixture
```

It needs Docker and the compiler image. The Biber fixture verifies that `latexmk` invokes Biber for `biblatex`; the BibTeX fixtures verify the BibTeX backend.

## Assistant

The **Assistant** panel (top bar, or the **?** button) is a LaTeX tutor for beginners. It runs on the API server, which calls the Anthropic API.

1. Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. The key stays on the server; it is never sent to the browser.
2. Restart the API (`npm run dev:all`).

Without a key, the panel shows "Assistant not configured" and everything else keeps working.

- **Asking.** Type a question, or use a quick prompt: insert table, insert figure, add citation, write equation, fix my compile errors. Answers stream in as they're written.
- **Context.** With **Share editor context** on, each question includes the open file, cursor position, selected text and the last compile log; the panel lists exactly what is sent. Turn it off to send only the question.
- **Explain this error.** Each error in **Logs** has this button. It sends the error, the log and the file it points to, and the answer explains the error in plain language and suggests a fix.
- **Changes need a click.** **Insert at cursor** (on every code block) and **Apply fix…** (which shows a before/after diff first) are the only ways an answer changes your project. A fix is refused if the lines changed after the assistant read them, and Undo reverts it.
- **Limits.** Requests are limited per IP (`ASSISTANT_RATE_LIMIT` per hour) and in size (`ASSISTANT_MAX_REQUEST_KB`). The model is `ASSISTANT_MODEL` (default `claude-haiku-5-5`).

A short **tour** (file tree → editor → Recompile → PDF → Logs → Assistant) runs the first time you open the editor. Skip it at any time, and reopen it from **Help → Take the tour** or the **?** button.

## Quality checks

```sh
npm run check        # lint, typecheck, unit tests, production build and browser e2e
npm run test:e2e    # browser tests only
npx playwright install chromium  # first-time browser setup
```

## Themes and layout

- **Theme.** Choose **Light**, **Dark** or **Auto** from the sun/moon/monitor button in the top bar, from **View** in the editor menu, or under **Settings → Appearance**. Auto follows the operating system and updates live. The choice is saved in the browser and applied before the page appears.
- **Panes.** Drag the dividers to resize the file tree and PDF preview; double-click a divider to reset it. The layout buttons switch between Editor & PDF, Editor only and PDF only.
- **Narrow screens.** The file tree becomes a drawer, and the editor and PDF are shown one at a time.

## Storage

Projects are saved to the API (`backend/storage`, override with `PAPERDESK_DATA`) and mirrored in the browser's local storage, so the editor keeps working while the API is offline. On load, local and server copies are merged and the most recently modified copy wins. Figures and other binary files are stored as base64 in the browser and as normal files on the server.

Configuration is through environment variables; see `.env.example`.

## Notes

- Vite + React + TypeScript; Monaco Editor (bundled, no CDN) for source and PDF.js for the preview.
- Not implemented yet: sharing, accounts, real-time collaboration, choosing a main file other than `main.tex`.
