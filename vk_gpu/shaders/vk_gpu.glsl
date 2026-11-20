// vk_gpu's bindless layout; compile with `glslc -I vk_gpu/shaders`.
// Textures are indexed by `Texture.index()`, buffers reached through
// `Buffer.addr()` (GL_EXT_buffer_reference), both passed in push constants.
// Every slot holds a texture (free ones a transparent black placeholder),
// so any index clamped by `gpu_index` is safe to sample. Define
// GPU_MAX_TEXTURES before including when `Options.max_textures` differs.
// Storage images (binding 2) need a format, so declare them yourself:
//   layout(set = 0, binding = 2, rgba8) uniform image2D gpu_images[];
// and index them with gpu_index() too.
#extension GL_EXT_nonuniform_qualifier : require

#ifndef GPU_MAX_TEXTURES
#define GPU_MAX_TEXTURES 16384
#endif

layout(set = 0, binding = 0) uniform texture2D gpu_textures[];
layout(set = 0, binding = 1) uniform sampler gpu_samplers[4];

#define GPU_LINEAR_CLAMP 0
#define GPU_NEAREST_CLAMP 1
#define GPU_LINEAR_REPEAT 2
#define GPU_NEAREST_REPEAT 3

uint gpu_index(uint tex) {
    return min(tex, uint(GPU_MAX_TEXTURES) - 1u);
}

vec4 gpu_sample(uint tex, uint smp, vec2 uv) {
    return texture(sampler2D(gpu_textures[nonuniformEXT(gpu_index(tex))], gpu_samplers[smp & 3u]), uv);
}
