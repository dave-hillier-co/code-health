#pragma once

namespace tools {

struct Util {
  static int scale(int v);
};

int clamp(int v);

template <typename T>
T convert(int v) {
  return T(v);
}

}  // namespace tools
