// Blend formulas from the Mac app: Core Graphics' PDF blend functions and Core Image's for the modes CG lacks, in gamma sRGB,
// composited as co = (1−αb)·cs + (1−αs)·cb + αs·αb·B(Cb, Cs). Mode numbers follow `blendModes` in model/types.ts.
export const blendGLSL = `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}
float burn(float b, float s) { return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s); }
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)); }
float softD(float b) { return b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); }
float vivid(float b, float s) { return s <= 0.5 ? burn(b, 2.0 * s) : dodge(b, 2.0 * s - 1.0); }
float blend1(int mode, float b, float s) {
  if (mode == 1) return min(b, s);
  if (mode == 2) return b * s;
  if (mode == 3) return burn(b, s);
  if (mode == 4) return max(0.0, b + s - 1.0);
  if (mode == 5) return max(b, s);
  if (mode == 6) return b + s - b * s;
  if (mode == 7) return dodge(b, s);
  if (mode == 8) return min(1.0, b + s);
  if (mode == 9) return b <= 0.5 ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b);
  if (mode == 10) return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (softD(b) - b);
  if (mode == 11) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (mode == 12) return vivid(b, s);
  if (mode == 13) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (mode == 14) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);
  if (mode == 15) return vivid(b, s) < 0.5 ? 0.0 : 1.0;
  if (mode == 16) return abs(b - s);
  if (mode == 17) return b + s - 2.0 * b * s;
  if (mode == 18) return max(0.0, b - s);
  if (mode == 19) return s <= 0.0 ? (b > 0.0 ? 1.0 : 0.0) : min(1.0, b / s);
  return s;
}
vec3 blendColor(int mode, vec3 b, vec3 s) {
  if (mode == 20) return setLum(setSat(s, sat(b)), lum(b));
  if (mode == 21) return setLum(setSat(b, sat(s)), lum(b));
  if (mode == 22) return setLum(s, lum(b));
  if (mode == 23) return setLum(b, lum(s));
  return vec3(blend1(mode, b.r, s.r), blend1(mode, b.g, s.g), blend1(mode, b.b, s.b));
}
vec3 unpremul(vec4 c) { return c.a > 0.0 ? min(c.rgb / c.a, 1.0) : vec3(0.0); }
vec4 composite(int mode, vec4 backdrop, vec4 source) {
  if (mode == 0) return source + backdrop * (1.0 - source.a);
  vec3 B = blendColor(mode, unpremul(backdrop), unpremul(source));
  float a = source.a + backdrop.a - source.a * backdrop.a;
  return vec4((1.0 - backdrop.a) * source.rgb + (1.0 - source.a) * backdrop.rgb + source.a * backdrop.a * B, a);
}
`

// Draws one source (a layer image, effects image or offscreen group) into a target, with opacity, its mask, folder clips,
// live-mask coverage and its blend mode.
export const layerFragment = `#version 300 es
precision highp float;
in vec2 sourceUV;
in vec2 docPosition;
uniform sampler2D image;
uniform vec2 imageSize;
uniform int filterMode;
uniform int antialias;
uniform float opacity;
uniform int maskMode;
uniform sampler2D mask;
uniform mat3 targetToMask;
uniform float maskOutside;
uniform int hasClip;
uniform sampler2D clip;
uniform int hasCoverage;
uniform sampler2D coverage;
uniform int blendMode;
uniform sampler2D backdrop;
uniform vec2 targetSize;
out vec4 color;
${blendGLSL}
vec4 cubicWeights(float t) {
  float t2 = t * t, t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
vec4 sampleImage(vec2 uv) {
  if (filterMode != 1) return texture(image, uv);
  vec2 p = uv * imageSize - 0.5, f = fract(p), base = floor(p);
  vec4 wx = cubicWeights(f.x), wy = cubicWeights(f.y);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    vec4 row = vec4(0.0);
    for (int i = 0; i < 4; i++) row += texture(image, (clamp(base + vec2(i - 1, j - 1), vec2(0.0), imageSize - 1.0) + 0.5) / imageSize) * wx[i];
    sum += row * wy[j];
  }
  sum = clamp(sum, 0.0, 1.0);
  return vec4(min(sum.rgb, sum.a), sum.a);
}
void main() {
  vec2 uv = sourceUV;
  float edge = 1.0;
  if (antialias == 1) {
    vec2 inside = min(uv, 1.0 - uv) / max(fwidth(uv), vec2(1e-6));
    edge = clamp(inside.x + 0.5, 0.0, 1.0) * clamp(inside.y + 0.5, 0.0, 1.0);
  } else if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) edge = 0.0;
  if (edge <= 0.0) discard;
  vec4 source = sampleImage(clamp(uv, 0.0, 1.0)) * edge * opacity;
  if (maskMode == 1) source *= texture(mask, clamp(uv, 0.0, 1.0)).r;
  else if (maskMode == 2) {
    vec2 m = (targetToMask * vec3(gl_FragCoord.xy, 1.0)).xy;
    source *= (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) ? maskOutside : texture(mask, m).r;
  }
  vec2 here = gl_FragCoord.xy / targetSize;
  if (hasClip == 1) source *= texture(clip, here).r;
  if (hasCoverage == 1) source *= texture(coverage, here).a;
  if (blendMode < 0) { color = source; return; }
  color = composite(blendMode, texture(backdrop, here), source);
}`

// Full-target passes: each reads `source` at the same pixel.
export const passVertex = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() { uv = corner; gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0); }`

export const copyFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D source;
uniform int mode;
uniform sampler2D alpha;
out vec4 color;
void main() {
  vec4 c = texture(source, uv);
  if (mode == 1) { color = vec4(c.a > 0.0 ? min(c.rgb / c.a, 1.0) : vec3(0.0), 1.0); return; }
  if (mode == 2) { float a = texture(alpha, uv).a; color = vec4(c.rgb * a, a); return; }
  color = c;
}`

// A folder mask stretched over the folder's own rectangle; zero outside it. Multiplied into the clip by the blend state.
export const clipFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D mask;
uniform mat3 targetToMask;
uniform vec2 targetSize;
out vec4 color;
void main() {
  vec2 m = (targetToMask * vec3(uv * targetSize, 1.0)).xy;
  float v = (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) ? 0.0 : texture(mask, m).r;
  color = vec4(v);
}`

export const hashGLSL = `
uint mix32(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float lattice(int ix, int iy, uint seed) {
  uint h = mix32(uint(ix) * 0x9E3779B1u ^ mix32(uint(iy) * 0x85EBCA77u ^ seed));
  return float(h & 0xFFFFu) / 65535.0 + float(h >> 16) / 65535.0 - 1.0;
}
float grainField(vec2 p, float scale, uint seed) {
  vec2 q = p / scale, cell = floor(q), t = q - cell;
  t = t * t * (3.0 - 2.0 * t);
  ivec2 i = ivec2(cell);
  float n00 = lattice(i.x, i.y, seed), n10 = lattice(i.x + 1, i.y, seed), n01 = lattice(i.x, i.y + 1, seed), n11 = lattice(i.x + 1, i.y + 1, seed);
  float top = n00 + (n10 - n00) * t.x, bottom = n01 + (n11 - n01) * t.x;
  return (top + (bottom - top) * t.y) * 1.6;
}
float noiseUnit(uint key) { return float(mix32(key) >> 8) * (1.0 / 16777216.0); }
`

// Color-only adjustments on a copy of the canvas. Modes: 1 per-channel table, 2 color cube, 3 invert, 4 grain, 5 noise.
export const adjustFragment = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
uniform sampler2D source;
uniform int mode;
uniform sampler2D table;
uniform sampler3D cube;
uniform vec4 params;
uniform uint seed;
uniform float unitsPerPixel;
uniform int gaussian;
uniform int monochromatic;
out vec4 color;
${hashGLSL}
void main() {
  vec4 p = texture(source, uv);
  if (p.a <= 0.0) { color = p; return; }
  vec3 c = min(p.rgb / p.a, 1.0);
  if (mode == 1) {
    vec3 x = c * 255.0;
    c = vec3(texture(table, vec2((x.r + 0.5) / 256.0, 1.0 / 6.0)).r, texture(table, vec2((x.g + 0.5) / 256.0, 0.5)).r, texture(table, vec2((x.b + 0.5) / 256.0, 5.0 / 6.0)).r);
  } else if (mode == 2) {
    c = texture(cube, (c * 32.0 + 0.5) / 33.0).rgb;
  } else if (mode == 3) {
    color = vec4(p.a - p.rgb, p.a); return;
  } else if (mode == 4) {
    vec2 at = (floor(gl_FragCoord.xy) + 0.5) * unitsPerPixel;
    float amount = params.x, size = params.y, rough = clamp(params.z / 100.0, 0.0, 1.0);
    float strength = min(amount, 100.0) / 100.0 * 0.35 * 255.0;
    float smooth1 = grainField(at, size, seed), fine = grainField(at, max(0.5, size * 0.35), mix32(seed ^ 0xA511E9B3u));
    float n = smooth1 + (fine - smooth1) * rough;
    vec3 v = c * 255.0;
    float level = min(1.0, dot(v, vec3(0.2126, 0.7152, 0.0722)) / 255.0);
    c = clamp(v + n * strength * (0.4 + 2.4 * level * (1.0 - level)), 0.0, 255.0) / 255.0;
  } else if (mode == 5) {
    uvec2 px = uvec2(floor(gl_FragCoord.xy));
    uint base = mix32(seed ^ mix32(px.x * 0x9e3779b9u ^ mix32(px.y * 0x85ebca6bu)));
    float spread = params.x / 100.0 * 127.5;
    vec3 v = c * 255.0;
    for (int k = 0; k < 3; k++) {
      uint key = monochromatic == 1 ? base : base + uint(k) * 0x9e3779b9u;
      float n = gaussian == 1 ? sqrt(-2.0 * log(1.0 - noiseUnit(key))) * cos(6.2831853 * noiseUnit(key ^ 0x68e31da4u)) * spread * (2.0 / 3.0) : (noiseUnit(key) * 2.0 - 1.0) * spread;
      v[k] = clamp(v[k] + n, 0.0, 255.0);
    }
    c = v / 255.0;
  }
  color = vec4(clamp(c, 0.0, 1.0) * p.a, p.a);
}`

// One pass of a Gaussian along `direction` (in source texels), transparent past the source's edges.
export const blurFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D source;
uniform vec2 direction;
uniform float sigma;
uniform int taps;
uniform float step;
out vec4 color;
void main() {
  vec2 texel = direction / vec2(textureSize(source, 0));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int k = -taps; k <= taps; k++) {
    float d = float(k) * step;
    float w = exp(-d * d / (2.0 * sigma * sigma));
    vec2 at = uv + texel * d;
    total += w;
    if (at.x < 0.0 || at.y < 0.0 || at.x > 1.0 || at.y > 1.0) continue;
    sum += texture(source, at) * w;
  }
  color = sum / total;
}`

// An adjustment's result put back into the canvas: blended in its mode over the opaque original, faded by its opacity,
// then cut by its mask (over its own rectangle) and enclosing folder clips.
export const adjustMixFragment = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D original;
uniform sampler2D adjusted;
uniform int blendMode;
uniform float opacity;
uniform int hasMask;
uniform sampler2D mask;
uniform mat3 targetToMask;
uniform vec2 targetSize;
uniform int hasClip;
uniform sampler2D clip;
out vec4 color;
${blendGLSL}
void main() {
  vec4 o = texture(original, uv), a = texture(adjusted, uv);
  if (blendMode != 0) {
    vec3 base = unpremul(o), top = unpremul(a);
    a = vec4(blendColor(blendMode, base, top) * o.a, o.a);
  }
  a = mix(o, a, opacity);
  float k = 1.0;
  if (hasMask == 1) {
    vec2 m = (targetToMask * vec3(uv * targetSize, 1.0)).xy;
    k = (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) ? 0.0 : texture(mask, m).r;
  }
  if (hasClip == 1) k *= texture(clip, uv).r;
  color = mix(o, a, k);
}`

// The composite on screen: a checkerboard under the document, then the document, then the pasteboard around it.
export const displayFragment = `#version 300 es
precision highp float;
in vec2 sourceUV;
in vec2 docPosition;
uniform sampler2D image;
uniform vec2 docSize;
uniform float zoom;
out vec4 color;
void main() {
  vec2 cell = floor(gl_FragCoord.xy / 8.0);
  vec3 checker = mod(cell.x + cell.y, 2.0) < 1.0 ? vec3(1.0) : vec3(0.8);
  vec4 c = texture(image, sourceUV);
  color = vec4(c.rgb + checker * (1.0 - c.a), 1.0);
}`
