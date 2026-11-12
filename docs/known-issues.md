# Known issues and limits

## Editing and compiling

- Real-time mode starts when a project is opened, so an owner has to reload once after sharing a project for the
  first time.
- Live documents are held in the API's memory. If the API restarts, up to a few seconds of typing may not have been
  saved yet; open browsers send their text again when they reconnect.
- Right after a recompile, the first click on the PDF can land while the new pages are still replacing the old ones
  and not jump to the source. Clicking again works.
- Warning locations follow the parentheses TeX prints in the log, so a warning from a deeply nested package may be
  attributed to the file that included it.
- A new project's first compile is slow on a small server (15 to 50 seconds for the larger templates); later
  compiles reuse the build folder and take a few seconds.

## Sharing and accounts

- A project link opens the project only for people who already have access. Someone without access sees a
  "no access" screen; there is no "request access" button yet, so they have to ask the owner directly.
- Sign-in returns to the project or invitation being opened by adding `?open=` or `?join=` to the return address.
  Supabase only honours that when the site is listed with a wildcard (`https://<site>/**`) under Authentication,
  URL Configuration, Redirect URLs. Without it, the target is kept in the browser's storage, which works only when
  the sign-in link is opened in the same browser.
- Invitations are links; no email is sent.
- Moving projects to an account on first sign-in does not move compiled PDFs; the next compile rebuilds them.
- The personal spelling dictionary and editor preferences are stored per browser, not per account.

## Submission check and exports

- Reference and file checks read the source directly. Names built by macros are only caught from the compile log,
  and `\includeonly`, `\import` and `\subimport` are not understood.
- Fonts are checked on the first 80 pages of the PDF.
- An export compiles the project twice while holding the single compile slot, so other compiles wait for it.
- Image files are renamed to plain ASCII when they are added, so the non-ASCII check mostly concerns other files.

## Development

- The API's health check calls `docker info` with a five-second limit. On a heavily loaded machine it can time out
  and answer 503, which fails browser tests that expect a clean console.
- `react-hooks/exhaustive-deps` is turned off: several effects in `src/main.tsx` deliberately depend on fewer values
  than they read.
- Some browser tests need Postgres and an S3-compatible store and are skipped unless `E2E_CLOUD_STORAGE=1` is set.
- Keep the checkout out of folders synced by iCloud Drive: evicted files in `node_modules` break the build.
