# Roadmap

Planned work, roughly in order. Nothing here is promised; it records what has been considered and why.

## Next

- A "request access" button on the no-access screen.
- Comments stored per comment on the server, so two people adding comments at once cannot overwrite each other.
- GitHub sync: choosing a branch other than the default, and merging both versions of a conflicting file line by
  line instead of choosing one.

## Later

- Typst: packages from a vendored offline set, an outline, completion, and PDF-to-source jumping.
- An experimental LaTeX-to-Typst conversion (it needs Pandoc, which is too large for the current API image).
- Spell checking in languages other than US English, and a personal dictionary that follows the account.
- `\includeonly`, `\import` and `\subimport` in the submission checks.
- More templates: thesis, poster, letterhead.
- Move the remaining per-file API routes under the per-project lock.

## Done recently

- Typst as a second document language, with three templates.
- GitHub sync: connect an account, link a project to a new or existing repository, push with a diff preview and a
  commit message, pull with a conflict view.
- Project chat with unread counts, links to files and lines, `@mentions` in chat and comments, and a notification
  bell (with an email when a mail provider is configured).
- Invitation emails.
- Template gallery with complete sample documents, previews, filters and search.
- Submission check with arXiv, journal and single-file exports.
- Pasting and dragging images into the editor as figures.
- Citations by DOI or arXiv ID.
- Real-time editing of shared projects, roles, invite links and per-file history.
- Accounts (email link and Google).
