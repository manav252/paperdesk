= Experiments <sec:experiments>

== Setup

Twelve nodes were installed in meeting rooms and shared offices of between 12 and 40 m#super[2]. Each room was
recorded for six weeks; the first four weeks were used for training and the last two for testing.

== Counting Accuracy

@tab:results compares our node with two common alternatives. The passive infrared sensor only reports
presence, so its count is taken as one whenever it detects motion.

#figure(
  table(
    columns: (1fr, auto, auto, auto),
    align: (left, center, center, center),
    stroke: none,
    table.hline(),
    table.header([Method], [MAE], [Presence], [Battery]),
    table.hline(stroke: 0.5pt),
    [Passive infrared], [1.62], [88.1%], [24 mo.],
    [CO#sub[2] threshold], [1.17], [81.4%], [mains],
    [Ours, single frame], [0.58], [96.9%], [14 mo.],
    [Ours, four frames], [*0.41*], [*98.2%*], [14 mo.],
    table.hline(),
  ),
  caption: [Counting error, presence accuracy and battery life.],
) <tab:results>

Stacking four frames reduces the mean absolute error from 0.58 to 0.41 people. @fig:accuracy shows that most
of the remaining error occurs when more than five people sit close together.

#figure(
  image("../figures/accuracy.png", width: 100%),
  caption: [Counting accuracy by number of occupants.],
) <fig:accuracy>

== Energy

Measured over a week, a node drew 23.6 #sym.mu\A on average, which matches @eq:current to within 4% and
corresponds to fourteen months on two AA cells.

== Effect on Ventilation

Driving the air handling units from the node's counts for two weeks reduced fan energy by 23% relative to the
previous fixed schedule, with no increase in complaints logged by the facilities team.
