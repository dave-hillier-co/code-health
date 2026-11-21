#include "retry.h"

void retry(std::function<void()> task) {
  task();
}
