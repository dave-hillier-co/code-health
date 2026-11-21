#include <string>

namespace geo {

template <typename T>
T clamp(T v, T lo, T hi) {
    if (v < lo) return lo;
    return v > hi ? hi : v;
}

std::string Shape::describe() const {
    auto raw = R"x(a { "b" ) // c
while (1) {)x";
    char brace = '{';
    int big = 1'000'000;
    for (int i = 0; i < 3; ++i) {
        if (i && big) {
            brace = '}';
        }
    }
    return raw;
}

}
