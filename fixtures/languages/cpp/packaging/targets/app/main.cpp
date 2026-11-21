#include <core/circle.h>
#include <core/shape.h>
#include "../core/src/detail.h"

int main() {
  Circle circle(2.0);
  const Shape& shape = circle;
  return static_cast<int>(scale(shape.area()));
}
