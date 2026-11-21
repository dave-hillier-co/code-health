#pragma once
#include <memory>
#include "../ports/store.h"

class Service {
 public:
  explicit Service(std::unique_ptr<Store> store) : store_(std::move(store)) {}

 private:
  std::unique_ptr<Store> store_;
};
