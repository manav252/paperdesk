= Methodology <sec:method>

== Sensor Node

@fig:overview shows the node. A thermal array measures an 8 #sym.times 8 grid of surface temperatures through
a 60#sym.degree lens mounted on the ceiling. A microcontroller with 256 kB of flash reads one frame every two
seconds, runs the network, and sends the count over a low-power radio only when it changes.

#figure(
  image("../figures/system-overview.png", width: 100%),
  caption: [The sensor node and its place in the building's ventilation control.],
) <fig:overview>

== Network

The input is a stack of four frames after subtracting a slowly updated background. Two separable convolution
blocks are followed by global average pooling and a linear layer with nine outputs, one per count from zero to
eight. The network has 3,940 parameters and is quantized to eight bits.

== Training

We minimise the cross-entropy between the predicted distribution $hat(y)$ and the labelled count $y$ over a
batch of $N$ examples,
$ cal(L) = - 1 / N sum_(i=1)^N sum_(c=0)^8 y_(i,c) log hat(y)_(i,c), $ <eq:loss>
using Adam @kingma2015adam with a learning rate of $10^(-3)$. Labels come from a camera that was present only
during data collection.

== Energy Budget

With the radio off, the average current is
$ I_"avg" = (t_"on" I_"on" + (T - t_"on") I_"sleep") / T, $ <eq:current>
where $T$ is the sampling period and $t_"on"$ the time spent awake. Minimising $t_"on"$ is the reason the
network in @eq:loss has to be small: inference takes 11 ms of each 2 s period.
