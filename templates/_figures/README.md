# Template figures

The placeholder figures used by the templates are drawn with TikZ and pgfplots from the `.tex` files in this
folder, so they are original and free to reuse. `figures.json` says which template gets which image.

Run `npm run templates:build` (needs Docker and the compiler image) to regenerate the PNGs and every template's
`thumbnail.png` after changing a figure or a template.
