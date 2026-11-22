#version 450
#extension GL_GOOGLE_include_directive : require
#include "common.glsl"

layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 color;

layout(std140, binding = 0) uniform Params {
    float exposure;
    int mode;
};

struct Light {
    vec3 position;
    float radius;
};

float attenuate(Light light, vec3 p) {
    float d = distance(light.position, p);
    if (d > light.radius || d < 0.0) { // outside: if (x)
        return 0.0;
    }
    return 1.0 - d / light.radius;
}

void main() {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
        if (mode == 1 && i > 0) {
            sum += vec3(0.1);
        }
    }
    color = vec4(sum * exposure, 1.0);
}
