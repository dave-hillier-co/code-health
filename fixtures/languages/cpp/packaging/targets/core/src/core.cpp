#include <core/circle.h>
#include "detail.h"

Circle::Circle(double radius) : radius_(radius) {}

double Circle::area() const {
  return scale(radius_ * radius_);
}
