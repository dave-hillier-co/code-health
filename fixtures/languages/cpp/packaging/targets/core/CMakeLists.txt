add_library(core STATIC src/core.cpp)
target_include_directories(core PUBLIC include PRIVATE src)
target_link_libraries(core PUBLIC base)
