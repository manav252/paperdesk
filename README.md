# Paperdesk Studio

An independent, Overleaf-inspired LaTeX workspace for learning and local use. Projects are kept in this browser by default; starting the optional API enables file-backed project endpoints, ZIP import/export, and isolated LaTeX compilation.

## Run the editor

```sh
npm install
npm run dev
```

Open the Vite address shown in the terminal. The dashboard and editor work without the API, with projects saved in browser local storage. To enable the server APIs in another terminal:

```sh
npm run server
```

The server listens on port 3001. In development, configure your browser/dev proxy as needed, or use the Vite proxy by adding `server.proxy` for `/api` in `vite.config.ts`.

## Themes and layout

Choose **Light**, **Dark**, or **Auto** from the sun/moon/monitor button in the top bar (dashboard and editor), from **View** in the editor menu, or under **Settings → Appearance**. Auto follows the operating system's color preference and updates live. The choice is saved in local storage (`paperdesk-theme`) and applied before first paint.

In the editor, drag the dividers to resize the file tree and PDF preview (double-click resets them), and use the layout buttons to switch between Editor & PDF, Editor only, and PDF only. On narrow screens the file tree opens as a drawer and the editor and PDF are shown one at a time. `⌘/Ctrl+Enter` recompiles.

## Enable real PDF compilation

Docker must be installed and running. Build the isolated compiler image once:

```sh
docker build -t paperdesk-texlive:latest -f Dockerfile.compiler .
```

Start `npm run server`, then compile from the editor. Every compile runs in a new container with networking disabled, resource limits, a read-only root filesystem, and a temporary project mount. The container is removed after compilation. No TeX execution occurs on the host.

## Notes

- Vite + React + TypeScript; Monaco Editor and PDF.js are used in the editor.
- The REST service uses filesystem project storage under `backend/storage` (override with `PAPERDESK_DATA`).
- The UI-only mode persists the project list and source files in this browser's local storage.
- Sharing, authentication, multi-user presence, and collaborative editing are not implemented. Socket.IO room hooks are provided as an integration starting point, without fake presence indicators.
- MongoDB is not required for the local prototype; filesystem metadata is used for simpler setup.

## Browser and server storage

The browser-only dashboard is immediately usable and stores projects in local storage. With the API running, the editor also loads server projects and debounced source changes are written to the filesystem. The REST API supports create/list/read/update/delete projects, file operations, upload, download, compile, PDF, and logs. For a deployed setup, set `PAPERDESK_DATA` to a persistent volume and place the API behind the same origin as Vite (or configure an appropriate reverse proxy).

The Docker compiler image is large and downloads TeX Live packages on first build. Engine selection is restricted to pdfLaTeX, XeLaTeX, and LuaLaTeX. Bibliography packages in the source can be run by latexmk when their tools are available in the image.
