#pragma once

class Store {
 public:
  virtual ~Store() = default;
  virtual void save(int value) = 0;
};
