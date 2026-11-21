#include "bus.h"

void wire(Bus& a, Bus& b) {
  connect(&a, &Bus::changed, &b, &Bus::changed);
}
