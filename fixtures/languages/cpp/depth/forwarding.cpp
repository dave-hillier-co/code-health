int forward(int a, int b) {
  return add(a, b);
}

void log(const char* message) {
  sink.write(message, 3);
}

int twice(int value) {
  return add(value, value + 1);
}
