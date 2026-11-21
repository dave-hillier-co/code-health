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
