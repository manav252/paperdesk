// Project report: title page, abstract, contents, chapters and a bibliography.
// The layout rules are in this file; each chapter is a file in chapters/. No packages are needed.

// ── Report details: replace these ──
#let title = [Campus Bike-Share Pilot]
#let subtitle = [Evaluation of the First Year and Recommendations]
#let authors = ("Rohan Kulkarni", "Sara Lindqvist", "Amara Nwosu")
#let organization = [Transport Working Group, Riverbend University]
#let date = [June 2026]

#set document(title: title, author: authors)
#set page(paper: "a4", margin: (x: 2.8cm, y: 3cm))
#set text(font: "New Computer Modern", size: 11pt)
#set par(justify: true, leading: 0.7em, spacing: 1.1em)
#set bibliography(title: [Bibliography], style: "ieee")

// Figures, tables and equations are numbered within their chapter: Figure 3.1, Table 3.1, (2.1).
#set heading(numbering: "1.1")
#let chapter-number() = counter(heading).get().first()
#set figure(numbering: n => numbering("1.1", chapter-number(), n))
#set math.equation(numbering: n => numbering("(1.1)", chapter-number(), n))
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.caption: set text(size: 10pt)

// A chapter starts on a new page with "Chapter N" above its title, and restarts the numbering inside it.
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  counter(figure.where(kind: image)).update(0)
  counter(figure.where(kind: table)).update(0)
  counter(math.equation).update(0)
  v(2.5cm)
  if it.numbering != none {
    text(size: 16pt, weight: "regular")[Chapter #counter(heading).display("1")]
    v(0.4cm)
  }
  text(size: 24pt, weight: "bold")[#it.body]
  v(1cm)
}
#show heading.where(level: 2): it => {
  v(0.6em)
  text(size: 14pt, weight: "bold")[#it]
  v(0.3em)
}

// ── Title page ──
#page(numbering: none)[
  #set align(center)
  #v(4cm)
  #text(size: 28pt, weight: "bold")[#title]
  #v(0.6cm)
  #text(size: 16pt)[#subtitle]
  #v(3cm)
  #text(size: 13pt)[#authors.join(linebreak())]
  #v(1fr)
  #organization \
  #date
  #v(1cm)
]

// ── Front matter: roman page numbers ──
#set page(numbering: "i")
#counter(page).update(1)

#heading(numbering: none, outlined: false)[Abstract]
Riverbend University ran a bike-share pilot of 120 bicycles and ten docking stations from September 2024 to
August 2025. This report evaluates the pilot against the three goals the Estates Committee set for it: that
the scheme be used, that it cost less per trip than the campus shuttle, and that it reduce short car journeys
between the two campuses. The scheme recorded 61,400 trips, at a cost of 38 pence per trip against 94 pence
for the shuttle, and one in six trips replaced a car journey. We recommend continuing the scheme, extending it
to the student village, and moving the two least-used stations.

#outline(title: [Contents], depth: 2, indent: auto)

// ── Chapters: arabic page numbers from 1 ──
#set page(numbering: "1")
#counter(page).update(1)

#include "chapters/introduction.typ"
#include "chapters/methods.typ"
#include "chapters/results.typ"
#include "chapters/recommendations.typ"

// Entries come from references.bib; only cited ones are printed.
#bibliography("references.bib")
