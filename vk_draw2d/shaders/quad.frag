#version 460
#include "vk_gpu.glsl"
#include "quad.glsl"

layout(location = 0) in vec2 local;
layout(location = 1) in vec2 uv;
layout(location = 2) flat in uint index;
layout(location = 0) out vec4 o;

// Signed distance to a box of half size `h` with corner radius `r`.
float box(vec2 x, vec2 h, float r) {
    vec2 d = abs(x) - h + r;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main() {
    Quad q = p.quads.q[index];
    vec2 f = gl_FragCoord.xy;
    if (f.x < q.clip.x || f.y < q.clip.y || f.x >= q.clip.z || f.y >= q.clip.w) {
        discard;
    }
    // A soft (shadow) shape was grown by `soft` on each side.
    vec2 h = q.rect.zw * 0.5 - q.soft;
    float d = box(local, h, min(q.radius, min(h.x, h.y)));
    float cover = q.soft > 0.0 ? 1.0 - smoothstep(-q.soft, q.soft, d) : clamp(0.5 - d, 0.0, 1.0);
    if (q.border > 0.0) {
        cover *= clamp(0.5 + d + q.border, 0.0, 1.0);
    }
    vec4 c = vec4(q.color.rgb * q.color.a, q.color.a);
    if (q.tex != 0xFFFFFFFFu) {
        c *= gpu_sample(q.tex, GPU_LINEAR_CLAMP, uv);
    }
    o = c * cover;
}
