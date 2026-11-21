// Awkward shapes for the lexical agreement corpus. Every function here is a unit the structural layer finds.
#include <functional>
#include <vector>

#define CHECK(expr) \
  do {              \
    if (!(expr)) {  \
      fail(#expr);  \
    }               \
  } while (false)

namespace acme::detail {

template <typename T, typename U = int>
T convert(const U& value) {
  return static_cast<T>(value);
}

template <typename T>
class Box {
 public:
  explicit Box(T value) : value_(std::move(value)) {}

  Box(const Box& other)
      : value_(other.value_) {}

  T& get() { return value_; }

  auto size() const -> int {
    return 1;
  }

  bool operator<(const Box& other) const {
    return value_ < other.value_;
  }

  template <typename F>
  auto map(F&& fn) const {
    return Box<decltype(fn(value_))>(fn(value_));
  }

 private:
  T value_;
};

struct Outer {
  struct Inner {
    int run() const {
      return 3;
    }
  };

  static int create(
      int first,
      int second) {
    return first + second;
  }

  Outer()
      : count_(0),
        label_("none") {}

  ~Outer() noexcept {}

 private:
  int count_;
  const char* label_;
};

int sum(const std::vector<int>& values) {
  int total = 0;
  for (int v : values) {
    total += v;
  }
  auto add = [&total](int extra) {
    total += extra;
  };
  add(1);
  std::function<int(int)> twice = [](int x) { return x * 2; };
  return twice(total);
}

int check(int x) {
  CHECK(x > 0);
  const char* text = "a { brace in a string";
  char open = '{';
  /* a block comment with { and } in it */
  return open == text[0] ? 1 : 0;
}

constexpr int square(int x) { return x * x; }

inline namespace v2 {
int versioned() {
  return 2;
}
}  // namespace v2

}  // namespace acme::detail

int main(int argc, char** argv) {
  return argc > 1 ? 1 : 0;
}
