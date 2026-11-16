#set page(paper: "a4")
#set heading(numbering: "1.")

= Typst Fixture Title

A paragraph with inline math $a^2 + b^2 = c^2$ and a reference to @sec:more.

#include "sections/more.typ"

#figure(
  table(columns: 2, [Name], [Value], [alpha], [1], [beta], [2]),
  caption: [A small table.],
)

See @knuth84.

#bibliography("refs.bib")
