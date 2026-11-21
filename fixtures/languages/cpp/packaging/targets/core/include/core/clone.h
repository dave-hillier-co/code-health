#pragma once

class Cloneable {
 public:
  virtual Cloneable* clone() const = 0;
  int tag() const { return 1; }
};
