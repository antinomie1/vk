// One shape: a rounded box in pixels, optionally textured, clipped.
// Shared by quad.vert and quad.frag; matches `Quad` in src/lib.mica.
#extension GL_EXT_buffer_reference : require

struct Quad {
    vec4 rect;   // x, y, w, h
    vec4 color;  // straight alpha; multiplies the texel
    vec4 clip;   // x0, y0, x1, y1
    vec2 uv;     // texture coordinates at the top left corner,
    vec2 du;     // their change across the width,
    vec2 dv;     // and down the height
    float radius;
    float border; // ring width; 0 fills
    float soft;   // edge falloff in pixels (shadows); 0 is antialiased
    uint tex;     // bindless index; 0xFFFFFFFF for none
    uint color_space; // 0: sRGB, 1: scRGB linear, 2: BT.2020 PQ, 3: BT.2020 HLG
    float pad;        // 96-byte stride
};

layout(buffer_reference, std430) readonly buffer Quads { Quad q[]; };
layout(push_constant) uniform P {
    Quads quads;
    vec2 size;
    uint dst_color; // 0: sRGB, 1: BT.2020 PQ, 2: scRGB linear
    float sdr_nits;
    float max_nits;
    uint pad;
} p;
