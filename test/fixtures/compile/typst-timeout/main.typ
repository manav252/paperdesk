= Never finishes in time

// Ten thousand million additions: far longer than any compile is allowed to run.
#for i in range(100000) {
  for j in range(100000) {
    let sum = i + j
  }
}
