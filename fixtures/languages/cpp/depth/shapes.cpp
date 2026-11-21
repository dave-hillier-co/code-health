class Counter {
 public:
  explicit Counter(int start) : value_(start) {}
  int next();
  void reset() { value_ = 0; }

 private:
  int value_;
  void hidden();
};

struct Point {
  int x;
  int y;
};

int answer() {
  return 42;
}
