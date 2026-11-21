#pragma once
#include "util.h"

class Consumer {
 public:
  explicit Consumer(tools::Util& util) : util_(util) {}
  int twice() { return util_.scale(1) * 2; }
  int run();

 private:
  tools::Util& util_;
};
