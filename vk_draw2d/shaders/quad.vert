#version 460
#include "quad.glsl"

layout(location = 0) out vec2 local;
layout(location = 1) out vec2 uv;
layout(location = 2) flat out uint index;

const vec2 corners[6] = vec2[](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));

void main() {
    Quad q = p.quads.q[gl_InstanceIndex];
    vec2 c = corners[gl_VertexIndex];
    gl_Position = vec4((q.rect.xy + c * q.rect.zw) / p.size * 2.0 - 1.0, 0.0, 1.0);
    local = (c - 0.5) * q.rect.zw;
    uv = mix(q.uv.xy, q.uv.zw, c);
    index = gl_InstanceIndex;
}
