// One shape: a rounded box in pixels, optionally textured, clipped.
// Shared by quad.vert and quad.frag; matches `Quad` in src/lib.mica.
#extension GL_EXT_buffer_reference : require

struct Quad {
    vec4 rect;   // x, y, w, h
    vec4 uv;     // u0, v0, u1, v1
    vec4 color;  // straight alpha; multiplies the texel
    vec4 clip;   // x0, y0, x1, y1
    float radius;
    float border; // ring width; 0 fills
    float soft;   // edge falloff in pixels (shadows); 0 is antialiased
    uint tex;     // bindless index; 0xFFFFFFFF for none
};

layout(buffer_reference, std430) readonly buffer Quads { Quad q[]; };
layout(push_constant) uniform P { Quads quads; vec2 size; } p;
