int withLambda(int n) {
  auto twice = [](int x) {
    return x > 0 ? x * 2 : 0;
  };
  return twice(n);
}

int callback(int n) {
  return apply(n, [&](int x) {
    if (x > n) {
      return x;
    }
    return n;
  });
}

int jump(int n) {
  int r = 0;
retry:
  r++;
  if (r < n) goto retry;
  return r;
}

int conditional(int n) {
#if defined(FAST)
  if (n > 10) {
    return 1;
  }
#else
  if (n > 20) {
    return 2;
  }
#endif
  return 0;
}
