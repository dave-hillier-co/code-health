#include "money.h"

namespace acme {

int total() {
  Money m;
  return add(m.cents(), 1);
}

}  // namespace acme
