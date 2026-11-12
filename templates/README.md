# Templates

Each folder here is one template in the gallery. When someone picks it, every file in the folder (except
`metadata.json` and `thumbnail.png`) becomes a file in their new project.

## Adding a template

1. Create a folder, for example `templates/thesis/`. Its name is the template's id.
2. Put the project in it: `main.tex`, and where it helps `sections/*.tex`, `figures/*.png` and `references.bib`.
   Write real sample content, list every package the sample uses, and mark the places to edit with short
   `%` comments.
3. Add `metadata.json`:

   ```json
   {
     "name": "Thesis",
     "description": "One sentence shown on the card.",
     "category": "Report",
     "tags": ["Report", "Thesis"],
     "mainFile": "main.tex",
     "engine": "pdflatex",
     "order": 10,
     "test": { "engines": ["pdflatex", "xelatex", "lualatex"], "minPages": 10, "bibtex": true, "contains": ["Text that must be in the PDF"] }
   }
   ```

   `category` is the filter the card appears under and must also be one of the `tags`. `order` sorts the gallery.
   `test` tells the compile check what to expect: the engines to try, `minPages` or `maxPages`, whether BibTeX
   must run (`bibtex`), whether the PDF must contain an image (`image`), and text it must contain.
4. Run `npm run templates:build -- thesis` to create `thumbnail.png` (page 1 of the compiled PDF).
5. Run `npm test` and `npm run test:templates`.

## Checks

- `npm test` checks that every template has complete metadata and a thumbnail, and that nothing in it is missing,
  undefined or unused (the same rules as "Check before submitting").
- `npm run test:templates` compiles every template with each engine it lists through the real API and fails if one
  does not compile, has unresolved references or citations, or lacks the expected text. It needs Docker and the
  compiler image (`npm run compiler:build`). `npm run test:compile` runs these together with the other fixtures.

## Figures

The placeholder figures are generated from the TikZ and pgfplots sources in `_figures/`, so they are original and
free to reuse. `_figures/figures.json` says which template gets which image; `npm run templates:build` regenerates
them. Folders whose names start with `_` are not templates.
