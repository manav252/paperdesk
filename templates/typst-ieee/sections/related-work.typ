= Related Work <sec:related>

Convolutional networks have been the standard tool for image recognition since they were shown to learn
features directly from pixels @lecun1998gradient. Residual connections made much deeper networks trainable
@he2016deep, and depthwise separable convolutions reduced their cost enough for phones @howard2017mobilenets.
Our network borrows the separable design but is two orders of magnitude smaller.

Occupancy changes slowly compared with the frame rate, so earlier frames carry information about the current
count. Recurrent networks such as long short-term memory @hochreiter1997long exploit this, at the cost of
state that must be kept in scarce memory. We instead stack the four most recent frames as input channels.
