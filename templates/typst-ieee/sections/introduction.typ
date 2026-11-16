= Introduction

Buildings account for roughly a third of final energy use, and a large share of it conditions air in rooms
that are empty. Ventilating to the number of people actually present is a well-known remedy, but it depends on
an occupancy signal that is accurate, cheap to install and acceptable to the people being counted.

Cameras give accurate counts and have benefited from deep convolutional networks @he2016deep, but they need
mains power and record identifiable images. Passive infrared sensors are cheap and private, yet they detect
motion rather than presence and cannot count. Carbon dioxide sensors lag occupancy by many minutes.

This paper describes a battery-powered node built around an 8 #sym.times 8 thermal array. Our contributions
are:

+ a network small enough for a microcontroller that counts up to eight occupants from thermal frames;
+ a duty-cycling scheme that keeps the average current under 25 #sym.mu\A; and
+ a six-week evaluation in twelve rooms of a working office building.

@sec:related reviews earlier work, @sec:method describes the node and the network, @sec:experiments reports
the results, and @sec:conclusion concludes.
