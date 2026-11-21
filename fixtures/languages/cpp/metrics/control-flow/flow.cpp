int plain(int a, int b) {
  return a + b;
}

int branches(int x) {
  if (x > 0) {
    return 1;
  } else if (x < 0) {
    // below zero
    return -1;
  } else {
    return 0;
  }
}

int loops(int n) {
  int total = 0;
  for (int i = 0; i < n; i++) {
    total += i;
  }
  for (int v : data) {
    total += v;
  }
  while (n > 0) {
    n--;
  }
  do {
    n++;
  } while (n < 3);
  return total;
}

int pick(int k) {
  switch (k) {
    case 1:
      return 10;
    case 2:
    case 3:
      return 20;
    default:
      return 0;
  }
}

int nested(int a, int b) {
  if (a) {
    for (int i = 0; i < b; i++) {

      // even indices only
      if (i % 2 == 0 && a > 1) {
        return i;
      }
    }
  }
  return 0;
}

int guarded(int a) {
  try {
    return risky(a);
  } catch (const std::exception& e) {
    return 0;
  } catch (...) {
    return -1;
  }
}
