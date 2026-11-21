#pragma once
#include "../ports/store.h"

class FileStore : public Store {
 public:
  void save(int value) override {}
};
