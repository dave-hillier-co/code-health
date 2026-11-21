bool both(bool a, bool b, bool c) {
  return a && b && c;
}

bool mixed(bool a, bool b, bool c) {
  return a && b || c;
}

bool keyword(bool a, bool b) {
  return a and b;
}

int ternary(bool a) {
  return a ? 1 : 2;
}

int combined(int a, int b) {
  if (a > 0 && b > 0 || a < -10) {
    return a ? b : -b;
  }
  return b;
}

void assign(int& total, int step) {
  total += step;
  total = total > 100 ? 100 : total;
}
