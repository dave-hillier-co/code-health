function legacy(a, b = 2, { c, d }) {
  while (a) {
    if (b) {
      a--;
    } else {
      a = 0;
    }
  }
}
