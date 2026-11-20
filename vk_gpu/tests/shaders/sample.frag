#version 460
#include "vk_gpu.glsl"

// Copies texture `tex` texel for texel into a target of the same size.
layout(push_constant) uniform P { uint tex; } p;
layout(location = 0) out vec4 o;

void main() {
    vec2 size = vec2(textureSize(sampler2D(gpu_textures[gpu_index(p.tex)], gpu_samplers[GPU_NEAREST_CLAMP]), 0));
    o = gpu_sample(p.tex, GPU_NEAREST_CLAMP, gl_FragCoord.xy / size);
}
