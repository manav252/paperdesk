// One-page CV. Change the details below; the layout rules are at the top.

// Layout: change the accent colour here.
#let accent = rgb("#1f5f8b")
#set document(title: "Ananya Mehta — CV", author: "Ananya Mehta")
#set page(paper: "a4", margin: 1.6cm)
#set text(font: "New Computer Modern", size: 10pt)
#set par(justify: false, leading: 0.55em, spacing: 0.7em)
#set list(indent: 0.4em, body-indent: 0.6em, spacing: 0.5em)
#show link: set text(fill: accent)
#show heading.where(level: 1): it => {
  v(0.5em)
  text(size: 12pt, weight: "bold", fill: accent)[#it.body]
  v(-0.75em)
  line(length: 100%, stroke: 0.5pt + accent)
  v(-0.2em)
}

// entry(title, dates, organisation, place): the two-line header of a job, degree or project.
#let entry(title, dates, organisation, place) = {
  grid(
    columns: (1fr, auto),
    row-gutter: 0.5em,
    strong(title), dates,
    emph(organisation), emph(place),
  )
}

// Header: replace with your name and contact details
#align(center)[
  #text(size: 24pt, weight: "bold")[Ananya Mehta] \
  #v(0.1em)
  Software Engineer \
  Mumbai, India | +91 98765 01234 |
  #link("mailto:ananya.mehta@example.com")[ananya.mehta\@example.com] |
  #link("https://ananyamehta.example")[ananyamehta.example] |
  #link("https://github.com/ananya-mehta-example")[github.com/ananya-mehta-example]
]

= Education

#entry[B.Tech. in Computer Engineering][2018 -- 2022][Western Coast Institute of Technology][Mumbai, India]
- CGPA 8.9 / 10. Final-year project on scheduling for shared GPU clusters.
- Coursework: distributed systems, databases, operating systems, machine learning.

= Experience

#entry[Software Engineer][Jul 2022 -- Present][Lakeside Payments][Mumbai, India]
- Built the reconciliation service that matches 4 million card transactions a day against bank statements,
  cutting manual review from six hours to forty minutes.
- Moved the settlement pipeline from nightly batches to streaming, reducing the delay before merchants see
  their balance from 24 hours to under five minutes.
- Mentored two interns, both of whom joined the team full time.

#entry[Software Engineering Intern][Jan 2022 -- Jun 2022][Lakeside Payments][Mumbai, India]
- Wrote a load-testing harness that replays recorded traffic; it found three race conditions before release.
- Added structured logging to the refund service, halving the time taken to diagnose failed refunds.

= Projects

#entry[Tessera, a tile map server][2023][Open source][github.com/ananya-mehta-example/tessera]
- Serves vector map tiles from a single file with no database; used by a city transit agency's trip planner.
- Written in Rust; 1,200 stars and 31 contributors.

#entry[Queue Clinic][2021][Hackathon winner][Mumbai, India]
- A text-message queueing system for outpatient clinics, piloted in two clinics with 300 patients a day.

= Skills

*Languages:* Rust, Go, Python, SQL, TypeScript \
*Systems:* PostgreSQL, Kafka, Redis, Kubernetes, AWS \
*Practices:* code review, incident response, load testing, technical writing

= Publications

A. Mehta and R. Iyer, "Fair Scheduling for Shared GPU Clusters Under Bursty Demand," in _Proceedings of the
National Conference on Parallel Computing_, 2022, pp. 112--119.

= Awards

- First place, Mumbai Civic Hackathon, 2021.
- Institute medal for the best final-year project in Computer Engineering, 2022.
