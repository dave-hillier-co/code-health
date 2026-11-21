int fact(int n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}

struct Tree {
  int depth(int n) {
    return n == 0 ? 0 : 1 + this->depth(n - 1);
  }
};

class Widget {
 public:
  explicit Widget(int size) : size_(size > 0 ? size : 1) {}
  ~Widget() {}
  bool operator==(const Widget& other) const {
    return size_ == other.size_;
  }
  int grow(int by);

 private:
  int size_;
};

int Widget::grow(int by) {
  if (by < 0) {
    return grow(-by);
  }
  size_ += by;
  return size_;
}

void noop(void) {}

template <typename... Args>
void many(int a, int b = 2, const char* c = nullptr, Args... rest) {}
