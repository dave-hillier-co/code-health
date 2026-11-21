#pragma once
#include <functional>

void retry(std::function<void()> task);
