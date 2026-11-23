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

vec3 srgb_to_linear(vec3 c) {
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    return mix(hi, lo, lessThanEqual(c, vec3(0.04045)));
}

vec3 linear_to_srgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
    return mix(hi, lo, lessThanEqual(c, vec3(0.0031308)));
}

vec3 pq_to_linear(vec3 n) {
    const float m1 = 0.1593017578125;
    const float m2 = 78.84375;
    const float c1 = 0.8359375;
    const float c2 = 18.8515625;
    const float c3 = 18.6875;
    vec3 np = pow(max(n, vec3(0.0)), vec3(1.0 / m2));
    return pow(max(np - c1, vec3(0.0)) / max(c2 - c3 * np, vec3(1e-6)), vec3(1.0 / m1));
}

vec3 linear_to_pq(vec3 l) {
    const float m1 = 0.1593017578125;
    const float m2 = 78.84375;
    const float c1 = 0.8359375;
    const float c2 = 18.8515625;
    const float c3 = 18.6875;
    vec3 lp = pow(max(l, vec3(0.0)), vec3(m1));
    return pow((c1 + c2 * lp) / (1.0 + c3 * lp), vec3(m2));
}

float hlg_inv_oetf(float e) {
    const float a = 0.17883277;
    const float b = 0.28466892;
    const float c = 0.55991073;
    return e <= 0.5 ? (e * e) / 3.0 : (exp((e - c) / a) + b) / 12.0;
}

vec3 hlg_to_linear(vec3 e) {
    return vec3(hlg_inv_oetf(e.r), hlg_inv_oetf(e.g), hlg_inv_oetf(e.b));
}

vec3 bt709_to_bt2020(vec3 c) {
    return vec3(
        dot(c, vec3(0.6274040, 0.3292820, 0.0433136)),
        dot(c, vec3(0.0690970, 0.9195400, 0.0113612)),
        dot(c, vec3(0.0163916, 0.0880132, 0.8955950))
    );
}

vec3 bt2020_to_bt709(vec3 c) {
    return vec3(
        dot(c, vec3( 1.6604910, -0.5876411, -0.0728499)),
        dot(c, vec3(-0.1245505,  1.1328999, -0.0083494)),
        dot(c, vec3(-0.0181508, -0.1005789,  1.1187297))
    );
}

vec4 convert_color(vec4 c, uint src_cs) {
    uint dst_cs = p.dst_color;
    if ((dst_cs == 0u && src_cs == 0u) ||
        (dst_cs == 1u && src_cs == 2u) ||
        (dst_cs == 2u && src_cs == 1u)) {
        return c;
    }
    float a = c.a;
    if (a <= 1e-6) {
        return vec4(0.0);
    }
    vec3 rgb = c.rgb / a;
    float sdr_nits = max(p.sdr_nits, 1.0);
    // Decode source into linear BT.709 luminance (cd/m^2).
    vec3 lin_nits;
    if (src_cs == 1u) {
        lin_nits = max(rgb, vec3(0.0)) * 80.0;
    } else if (src_cs == 2u) {
        lin_nits = bt2020_to_bt709(pq_to_linear(clamp(rgb, 0.0, 1.0)) * 10000.0);
    } else if (src_cs == 3u) {
        lin_nits = bt2020_to_bt709(hlg_to_linear(clamp(rgb, 0.0, 1.0)) * 1000.0);
    } else {
        lin_nits = srgb_to_linear(clamp(rgb, 0.0, 1.0)) * sdr_nits;
    }
    // Encode into destination color space.
    vec3 out_rgb;
    if (dst_cs == 1u) {
        vec3 bt2020 = max(bt709_to_bt2020(lin_nits), vec3(0.0));
        out_rgb = linear_to_pq(clamp(bt2020 / 10000.0, 0.0, 1.0));
    } else if (dst_cs == 2u) {
        out_rgb = max(lin_nits, vec3(0.0)) / 80.0;
    } else {
        vec3 v = max(lin_nits, vec3(0.0)) / sdr_nits;
        float lum = dot(v, vec3(0.2126, 0.7152, 0.0722));
        if (lum > 1e-6) {
            float lmax = max(p.max_nits / sdr_nits, 2.0);
            float lum_out = (lum * (1.0 + lum / (lmax * lmax))) / (1.0 + lum);
            v *= (lum_out / lum);
        }
        out_rgb = linear_to_srgb(clamp(v, 0.0, 1.0));
    }
    return vec4(out_rgb * a, a);
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
    c = convert_color(c, q.color_space);
    o = c * cover;
}
