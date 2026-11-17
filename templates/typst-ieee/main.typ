// IEEE-style conference paper. The layout rules are in this file; the text of each section is in sections/.
// Nothing here needs a package: it compiles with Typst alone.

// Paper details: replace these
#let title = [Low-Power Occupancy Sensing for Smart Buildings Using Edge-Deployed Neural Networks]
#let authors = (
  (
    name: "Priya Raman",
    department: [Dept. of Electrical Engineering],
    organization: [Northfield Institute of Technology],
    location: [Pune, India],
    email: "priya.raman@northfield.example",
  ),
  (
    name: "Daniel Okafor",
    department: [Dept. of Computer Science],
    organization: [Northfield Institute of Technology],
    location: [Pune, India],
    email: "daniel.okafor@northfield.example",
  ),
  (
    name: "Mei Tanaka",
    department: [Building Systems Group],
    organization: [Harbour Automation Ltd.],
    location: [Osaka, Japan],
    email: "m.tanaka@harbour-automation.example",
  ),
)
#let abstract = [
  Heating and ventilation waste energy when they serve empty rooms, yet camera-based occupancy sensing raises
  privacy concerns and needs more power than a battery can supply. We present a sensor node that estimates how
  many people are in a room from a low-resolution thermal array, using a small convolutional network that runs
  on a microcontroller. In a six-week deployment across twelve rooms the node counts occupants with a mean
  absolute error of 0.41 people and runs for fourteen months on two AA cells. Controlling ventilation with its
  estimates reduced fan energy by 23% compared with a fixed schedule.
]
#let keywords = ("occupancy sensing", "edge computing", "thermal imaging", "smart buildings", "TinyML")

// Layout: US letter, two columns, 10 pt, as in IEEE conference proceedings
#set document(title: title, author: authors.map(a => a.name))
#set page(paper: "us-letter", margin: (x: 0.62in, top: 0.75in, bottom: 1in), columns: 2)
#set columns(gutter: 0.2in)
#set text(font: "New Computer Modern", size: 10pt)
#set par(justify: true, first-line-indent: 1em, spacing: 0.65em, leading: 0.55em)
#set enum(indent: 1em)
#set list(indent: 1em)
#set math.equation(numbering: "(1)")
#show figure.caption: set text(size: 8pt)
#set figure(supplement: [Fig.])
#show figure.where(kind: table): set figure(supplement: [Table], numbering: "I")
#show figure.where(kind: table): set figure.caption(position: top)
#show figure.where(kind: table): set text(size: 8pt)
#set bibliography(title: [References], style: "ieee")
#show bibliography: set text(size: 8pt)

// Section headings: "I. INTRODUCTION" centred in small capitals, "A. Subsection" in italics.
#set heading(numbering: "I.A.")
#show heading.where(level: 1): it => {
  set align(center)
  set text(size: 10pt, weight: "regular")
  v(1.1em, weak: true)
  if it.numbering != none {
    numbering("I.", counter(heading).get().first())
    h(0.6em)
  }
  smallcaps(it.body)
  v(0.7em, weak: true)
}
#show heading.where(level: 2): it => {
  set text(size: 10pt, weight: "regular", style: "italic")
  v(0.9em, weak: true)
  if it.numbering != none {
    numbering("A.", counter(heading).get().last())
    h(0.5em)
  }
  it.body
  v(0.6em, weak: true)
}

// Title and authors, across both columns
#place(top + center, scope: "parent", float: true, clearance: 1.6em)[
  #text(size: 22pt)[#title]
  #v(1.2em)
  #grid(
    columns: authors.len(),
    column-gutter: 2em,
    ..authors.map(a => align(center)[
      #a.name \
      #text(style: "italic")[#a.department] \
      #text(style: "italic")[#a.organization] \
      #a.location \
      #a.email
    ]),
  )
]

// Abstract and index terms
#[
  #set text(size: 9pt, weight: "bold")
  #set par(first-line-indent: 0pt)
  _Abstract_---#abstract

  _Index Terms_---#keywords.join(", ")
]

// Sections: one file each
#include "sections/introduction.typ"
#include "sections/related-work.typ"
#include "sections/methodology.typ"
#include "sections/experiments.typ"
#include "sections/conclusion.typ"

// Acknowledgements are not numbered.
#heading(numbering: none)[Acknowledgment]
The authors thank the facilities team at Northfield Institute of Technology for access to the test rooms and
the building management logs.

// Entries come from references.bib; only cited ones are printed.
#bibliography("references.bib")
