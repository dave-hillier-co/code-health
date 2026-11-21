#include "consumer.h"

using namespace tools;

int Consumer::run() {
  int a = Util::scale(2);
  int b = clamp(a);
  return convert<int>(b);
}
