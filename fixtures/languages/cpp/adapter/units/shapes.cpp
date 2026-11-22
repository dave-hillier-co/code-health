namespace acme {

int plain(int a) {
  return a;
}

int plain(double a) {
  return 1;
}

class Widget {
 public:
  Widget() {}
  void draw() const {}
  ~Widget();
  static int make();

  class Part {
   public:
    int size() { return 1; }
  };
};

Widget::~Widget() {}

int Widget::make() {
  auto helper = [](int x) { return x; };
  return helper(1);
}

template <typename T>
T identity(T value) {
  return value;
}

}  // namespace acme

namespace other {

class Widget {
 public:
  void draw() const {}
};

}  // namespace other

namespace {

int hidden() {
  return 1;
}

}  // namespace

inline namespace v2 {

int version() {
  return 2;
}

}  // inline namespace v2

namespace outer::inner {

int deep() {
  return 1;
}

}  // namespace outer::inner

int acme::Widget::count() {
  return 0;
}

int acme::Widget::Part::weight() {
  return 2;
}

int far::Away::Deep::reach() {
  return 3;
}
