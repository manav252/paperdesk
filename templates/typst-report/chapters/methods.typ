= Methods <ch:methods>

== Overview

The evaluation combines three sources, shown in @fig:method: the trip log kept by the docking stations, the
university's accounts for the scheme and for the shuttle, and a survey of people who used the scheme.

#figure(
  image("../figures/method.png", width: 85%),
  caption: [How the three sources of data feed the three measures.],
) <fig:method>

== Trip Data

Every docking station records when a bicycle is taken and when it is returned. We removed trips shorter than
one minute, which are almost always a bicycle being returned to the same dock because of a fault, and trips
longer than six hours, which indicate a bicycle that was not docked properly. This left 61,400 trips out of
63,950 records.

== Measuring Cost

The cost per trip is the yearly cost of the scheme divided by the number of trips,
$ c = (C_"lease" + C_"maintenance" + C_"staff") / n, $ <eq:cost>
where $n$ is the number of trips after cleaning. The shuttle is costed in the same way from its contract and
passenger counts, so the two figures can be compared directly.

== Survey

In May 2025 we emailed a short survey to everyone who had made at least five trips. Of 2,140 people asked,
803 replied. The central question was how they would have made their most recent trip had the scheme not
existed, a method used in earlier evaluations to estimate how many car journeys a scheme replaces
@fishman2013bike. Weather affects cycling strongly @gebhart2014impact, so answers were weighted by the month
of the trip they described.
