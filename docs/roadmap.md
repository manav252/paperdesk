# Roadmap

Planned work, roughly in order. Nothing here is promised; it records what has been considered and why.

## Next

- **Project chat and mentions.** A chat panel per project over the existing live connection, stored in Postgres,
  with unread counts, links to files and lines, `@mentions` of collaborators in chat and comments, and an in-app
  notification list. Email notifications only if a free mail provider is configured.
- **GitHub sync.** Link a project to a repository through a GitHub OAuth App, with push and pull, a diff before
  pushing and a conflict view on pull. Tokens encrypted on the server and revocable from Settings. Build files are
  never pushed.

## Later

- Email for invitations, so the owner does not have to send the link by hand.
- Spell checking in languages other than US English, and a personal dictionary that follows the account.
- `\includeonly`, `\import` and `\subimport` in the submission checks.
- More templates: thesis, poster, letterhead.
- Move the remaining per-file API routes under the per-project lock.

## Done recently

- Template gallery with complete sample documents, previews, filters and search.
- Submission check with arXiv, journal and single-file exports.
- Pasting and dragging images into the editor as figures.
- Citations by DOI or arXiv ID.
- Real-time editing of shared projects, roles, invite links and per-file history.
- Accounts (email link and Google).
