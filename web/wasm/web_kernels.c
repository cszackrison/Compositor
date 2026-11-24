#include <stdint.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <wasm_simd128.h>

// Web-only SIMD128 pixel kernels compiled into kernels.wasm alongside Compositor/Rendering/*.c.
// Kept separate from Compositor/Rendering so macOS upstream kernels stay untouched.

// MARK: Box blur (exact float64 running sums matching model/pixels.ts blurFloats)

static void blur_row_pass_4(const float *src, float *out, int width, int height, int radius, int clamp) {
    const double scale = 1.0 / (radius * 2 + 1);
    const v128_t vscale = wasm_f64x2_splat(scale);
    const int lo = radius < width ? radius : width;
    const int hi = width - radius - 1 > lo ? width - radius - 1 : lo;
    const int reach = (radius + 1) * 4;
    const int back = radius * 4;
    const int rowStride = width * 4;
    for (int y = 0; y < height; ++y) {
        const float *row = src + y * rowStride;
        float *dst = out + y * rowStride;
        const float *last = row + rowStride - 4;
        const v128_t f01 = clamp ? wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(row)) : wasm_f64x2_splat(0.0);
        const v128_t f23 = clamp ? wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(row + 2)) : wasm_f64x2_splat(0.0);
        const v128_t e01 = clamp ? wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(last)) : wasm_f64x2_splat(0.0);
        const v128_t e23 = clamp ? wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(last + 2)) : wasm_f64x2_splat(0.0);
        v128_t s01 = wasm_f64x2_splat(0.0), s23 = wasm_f64x2_splat(0.0);
        for (int k = -radius; k <= radius; ++k) {
            if (k < 0) {
                s01 = wasm_f64x2_add(s01, f01);
                s23 = wasm_f64x2_add(s23, f23);
            } else if (k >= width) {
                s01 = wasm_f64x2_add(s01, e01);
                s23 = wasm_f64x2_add(s23, e23);
            } else {
                const float *p = row + k * 4;
                v128_t v = wasm_v128_load(p);
                s01 = wasm_f64x2_add(s01, wasm_f64x2_promote_low_f32x4(v));
                s23 = wasm_f64x2_add(s23, wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 1)));
            }
        }
        int i = 0, o = 0;
        for (; i < lo; ++i, o += 4) {
            v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s01, vscale));
            v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s23, vscale));
            wasm_v128_store(dst + o, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
            if (i + radius + 1 < width) {
                v128_t a = wasm_v128_load(row + o + reach);
                v128_t a01 = wasm_f64x2_promote_low_f32x4(a);
                v128_t a23 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(a, a, 1, 1));
                s01 = wasm_f64x2_add(s01, wasm_f64x2_sub(a01, f01));
                s23 = wasm_f64x2_add(s23, wasm_f64x2_sub(a23, f23));
            } else {
                s01 = wasm_f64x2_add(s01, wasm_f64x2_sub(e01, f01));
                s23 = wasm_f64x2_add(s23, wasm_f64x2_sub(e23, f23));
            }
        }
        for (; i < hi; ++i, o += 4) {
            v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s01, vscale));
            v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s23, vscale));
            wasm_v128_store(dst + o, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
            v128_t a = wasm_v128_load(row + o + reach);
            v128_t b = wasm_v128_load(row + o - back);
            v128_t a01 = wasm_f64x2_promote_low_f32x4(a);
            v128_t a23 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(a, a, 1, 1));
            v128_t b01 = wasm_f64x2_promote_low_f32x4(b);
            v128_t b23 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(b, b, 1, 1));
            s01 = wasm_f64x2_add(s01, wasm_f64x2_sub(a01, b01));
            s23 = wasm_f64x2_add(s23, wasm_f64x2_sub(a23, b23));
        }
        for (; i < width; ++i, o += 4) {
            v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s01, vscale));
            v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s23, vscale));
            wasm_v128_store(dst + o, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
            if (i >= radius) {
                v128_t b = wasm_v128_load(row + o - back);
                v128_t b01 = wasm_f64x2_promote_low_f32x4(b);
                v128_t b23 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(b, b, 1, 1));
                s01 = wasm_f64x2_add(s01, wasm_f64x2_sub(e01, b01));
                s23 = wasm_f64x2_add(s23, wasm_f64x2_sub(e23, b23));
            } else {
                s01 = wasm_f64x2_add(s01, wasm_f64x2_sub(e01, f01));
                s23 = wasm_f64x2_add(s23, wasm_f64x2_sub(e23, f23));
            }
        }
    }
}

static void blur_row_pass_1(const float *src, float *out, int width, int height, int radius, int clamp) {
    const double scale = 1.0 / (radius * 2 + 1);
    const int lo = radius < width ? radius : width;
    const int hi = width - radius - 1 > lo ? width - radius - 1 : lo;
    const int reach = radius + 1;
    for (int y = 0; y < height; ++y) {
        const float *row = src + y * width;
        float *dst = out + y * width;
        const double f = clamp ? (double)row[0] : 0.0;
        const double e = clamp ? (double)row[width - 1] : 0.0;
        double s = 0.0;
        for (int k = -radius; k <= radius; ++k) {
            s += k < 0 ? f : (k >= width ? e : (double)row[k]);
        }
        int i = 0;
        for (; i < lo; ++i) {
            dst[i] = (float)(s * scale);
            s += (i + reach < width ? (double)row[i + reach] : e) - f;
        }
        for (; i < hi; ++i) {
            dst[i] = (float)(s * scale);
            s += (double)row[i + reach] - (double)row[i - radius];
        }
        for (; i < width; ++i) {
            dst[i] = (float)(s * scale);
            s += e - (i >= radius ? (double)row[i - radius] : f);
        }
    }
}

static void blur_column_pass(const float *src, float *out, int width, int height, int channels, int radius, int clamp, double *sums) {
    const double scale = 1.0 / (radius * 2 + 1);
    const v128_t vscale = wasm_f64x2_splat(scale);
    const int n = width * channels;
    const int last = (height - 1) * n;
    memset(sums, 0, (size_t)n * sizeof(double));
    for (int k = -radius; k <= radius; ++k) {
        int r = k < 0 ? (clamp ? 0 : -1) : (k >= height ? (clamp ? last : -1) : k * n);
        if (r >= 0) {
            const float *row = src + r;
            int x = 0;
            for (; x + 4 <= n; x += 4) {
                v128_t v = wasm_v128_load(row + x);
                v128_t s0 = wasm_f64x2_add(wasm_v128_load(sums + x), wasm_f64x2_promote_low_f32x4(v));
                v128_t s1 = wasm_f64x2_add(wasm_v128_load(sums + x + 2), wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 1)));
                wasm_v128_store(sums + x, s0);
                wasm_v128_store(sums + x + 2, s1);
            }
            for (; x < n; ++x) sums[x] += (double)row[x];
        }
    }
    for (int y = 0; y < height; ++y) {
        int ka = y + radius + 1, ks = y - radius;
        int add = ka < 0 ? (clamp ? 0 : -1) : (ka >= height ? (clamp ? last : -1) : ka * n);
        int sub = ks < 0 ? (clamp ? 0 : -1) : (ks >= height ? (clamp ? last : -1) : ks * n);
        float *dst = out + y * n;
        if (add >= 0 && sub >= 0) {
            const float *ra = src + add, *rs = src + sub;
            int x = 0;
            for (; x + 4 <= n; x += 4) {
                v128_t s0 = wasm_v128_load(sums + x);
                v128_t s1 = wasm_v128_load(sums + x + 2);
                v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s0, vscale));
                v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s1, vscale));
                wasm_v128_store(dst + x, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
                v128_t va = wasm_v128_load(ra + x);
                v128_t vs = wasm_v128_load(rs + x);
                v128_t a0 = wasm_f64x2_promote_low_f32x4(va);
                v128_t a1 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(va, va, 1, 1));
                v128_t b0 = wasm_f64x2_promote_low_f32x4(vs);
                v128_t b1 = wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(vs, vs, 1, 1));
                wasm_v128_store(sums + x, wasm_f64x2_add(s0, wasm_f64x2_sub(a0, b0)));
                wasm_v128_store(sums + x + 2, wasm_f64x2_add(s1, wasm_f64x2_sub(a1, b1)));
            }
            for (; x < n; ++x) {
                double v = sums[x];
                dst[x] = (float)(v * scale);
                sums[x] = v + ((double)ra[x] - (double)rs[x]);
            }
        } else if (add >= 0) {
            const float *ra = src + add;
            int x = 0;
            for (; x + 4 <= n; x += 4) {
                v128_t s0 = wasm_v128_load(sums + x);
                v128_t s1 = wasm_v128_load(sums + x + 2);
                v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s0, vscale));
                v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s1, vscale));
                wasm_v128_store(dst + x, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
                v128_t va = wasm_v128_load(ra + x);
                wasm_v128_store(sums + x, wasm_f64x2_add(s0, wasm_f64x2_promote_low_f32x4(va)));
                wasm_v128_store(sums + x + 2, wasm_f64x2_add(s1, wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(va, va, 1, 1))));
            }
            for (; x < n; ++x) {
                double v = sums[x];
                dst[x] = (float)(v * scale);
                sums[x] = v + (double)ra[x];
            }
        } else if (sub >= 0) {
            const float *rs = src + sub;
            int x = 0;
            for (; x + 4 <= n; x += 4) {
                v128_t s0 = wasm_v128_load(sums + x);
                v128_t s1 = wasm_v128_load(sums + x + 2);
                v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s0, vscale));
                v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(s1, vscale));
                wasm_v128_store(dst + x, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
                v128_t vs = wasm_v128_load(rs + x);
                wasm_v128_store(sums + x, wasm_f64x2_sub(s0, wasm_f64x2_promote_low_f32x4(vs)));
                wasm_v128_store(sums + x + 2, wasm_f64x2_sub(s1, wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(vs, vs, 1, 1))));
            }
            for (; x < n; ++x) {
                double v = sums[x];
                dst[x] = (float)(v * scale);
                sums[x] = v - (double)rs[x];
            }
        } else {
            int x = 0;
            for (; x + 4 <= n; x += 4) {
                v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(wasm_v128_load(sums + x), vscale));
                v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_f64x2_mul(wasm_v128_load(sums + x + 2), vscale));
                wasm_v128_store(dst + x, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
            }
            for (; x < n; ++x) dst[x] = (float)(sums[x] * scale);
        }
    }
}

static void u8_to_f32(const uint8_t *src, float *dst, size_t total) {
    size_t i = 0;
    for (; i + 16 <= total; i += 16) {
        v128_t bytes = wasm_v128_load(src + i);
        v128_t lo16 = wasm_u16x8_extend_low_u8x16(bytes);
        v128_t hi16 = wasm_u16x8_extend_high_u8x16(bytes);
        wasm_v128_store(dst + i, wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(lo16)));
        wasm_v128_store(dst + i + 4, wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(lo16)));
        wasm_v128_store(dst + i + 8, wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(hi16)));
        wasm_v128_store(dst + i + 12, wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(hi16)));
    }
    for (; i < total; ++i) dst[i] = (float)src[i];
}

static void f32_to_u8(const float *src, uint8_t *dst, size_t total) {
    const v128_t half = wasm_f32x4_splat(0.5f);
    size_t i = 0;
    for (; i + 16 <= total; i += 16) {
        v128_t i0 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_v128_load(src + i), half));
        v128_t i1 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_v128_load(src + i + 4), half));
        v128_t i2 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_v128_load(src + i + 8), half));
        v128_t i3 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_add(wasm_v128_load(src + i + 12), half));
        v128_t u0 = wasm_u16x8_narrow_i32x4(i0, i1);
        v128_t u1 = wasm_u16x8_narrow_i32x4(i2, i3);
        wasm_v128_store(dst + i, wasm_u8x16_narrow_i16x8(u0, u1));
    }
    for (; i < total; ++i) {
        int v = (int)(src[i] + 0.5f);
        dst[i] = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
    }
}

__attribute__((export_name("web_blur_floats")))
int web_blur_floats(float *data, int width, int height, int channels, const int *radii, int count, int clamp) {
    if (width <= 0 || height <= 0 || (channels != 1 && channels != 4) || count <= 0) return 1;
    size_t total = (size_t)width * (size_t)height * (size_t)channels;
    float *tmp = malloc(total * sizeof(float));
    double *sums = malloc((size_t)width * (size_t)channels * sizeof(double));
    if (!tmp || !sums) { free(tmp); free(sums); return 0; }
    for (int i = 0; i < count; ++i) {
        int r = radii[i];
        if (r <= 0) continue;
        if (channels == 4) blur_row_pass_4(data, tmp, width, height, r, clamp);
        else blur_row_pass_1(data, tmp, width, height, r, clamp);
        blur_column_pass(tmp, data, width, height, channels, r, clamp, sums);
    }
    free(tmp);
    free(sums);
    return 1;
}

__attribute__((export_name("web_blur_u8")))
int web_blur_u8(const uint8_t *src, uint8_t *dst, int width, int height, int channels, const int *radii, int count, int clamp) {
    if (width <= 0 || height <= 0 || (channels != 1 && channels != 4) || count <= 0) return 1;
    size_t total = (size_t)width * (size_t)height * (size_t)channels;
    float *buf = malloc(total * sizeof(float));
    if (!buf) return 0;
    u8_to_f32(src, buf, total);
    int ok = web_blur_floats(buf, width, height, channels, radii, count, clamp);
    if (ok) f32_to_u8(buf, dst, total);
    free(buf);
    return ok;
}

// 1D box-blur approximation of a horizontal (axis=0) or vertical (axis=1) Gaussian for axis-aligned Motion Blur (O(1) per pixel).
__attribute__((export_name("web_blur_1d_f32")))
int web_blur_1d_f32(float *data, int width, int height, int axis, const int *radii, int count, int clamp) {
    if (width <= 0 || height <= 0 || count <= 0) return 1;
    size_t total = (size_t)width * (size_t)height * 4;
    float *tmp = malloc(total * sizeof(float));
    double *sums = axis ? malloc((size_t)width * 4 * sizeof(double)) : NULL;
    if (!tmp || (axis && !sums)) { free(tmp); free(sums); return 0; }
    float *cur = data, *nxt = tmp;
    for (int i = 0; i < count; ++i) {
        int r = radii[i];
        if (r <= 0) continue;
        if (axis == 0) blur_row_pass_4(cur, nxt, width, height, r, clamp);
        else blur_column_pass(cur, nxt, width, height, 4, r, clamp, sums);
        float *swap = cur; cur = nxt; nxt = swap;
    }
    if (cur != data) memcpy(data, cur, total * sizeof(float));
    free(tmp);
    free(sums);
    return 1;
}

__attribute__((export_name("web_blur_1d_u8")))
int web_blur_1d_u8(const uint8_t *src, uint8_t *dst, int width, int height, int axis, const int *radii, int count, int clamp) {
    if (width <= 0 || height <= 0 || count <= 0) return 1;
    size_t total = (size_t)width * (size_t)height * 4;
    float *buf = malloc(total * sizeof(float));
    if (!buf) return 0;
    u8_to_f32(src, buf, total);
    int ok = web_blur_1d_f32(buf, width, height, axis, radii, count, clamp);
    if (ok) f32_to_u8(buf, dst, total);
    free(buf);
    return ok;
}

// MARK: Coalesced sparse 2D convolution for Motion Blur (SIMD128 f32x4, symmetric pairing + 64-column strip tiling)

static void motion_blur_core_f32(const float *src, float *dst, int width, int height,
                                 const int *dx, const int *dy, const float *wt, int taps, int clamped) {
    int minDx = 0, maxDx = 0, minDy = 0, maxDy = 0;
    for (int k = 0; k < taps; ++k) {
        if (dx[k] < minDx) minDx = dx[k];
        if (dx[k] > maxDx) maxDx = dx[k];
        if (dy[k] < minDy) minDy = dy[k];
        if (dy[k] > maxDy) maxDy = dy[k];
    }
    int *off = malloc((size_t)taps * sizeof(int));
    if (!off) return;
    const int rowStride = width * 4;
    for (int k = 0; k < taps; ++k) off[k] = dy[k] * rowStride + dx[k] * 4;

    // Check if the sorted tap table is palindromically symmetric: off[k] == -off[taps-1-k] && wt[k] == wt[taps-1-k].
    int sym = 1;
    const int half = taps / 2;
    for (int k = 0; k < half; ++k) {
        int m = taps - 1 - k;
        if (off[k] != -off[m] || fabsf(wt[k] - wt[m]) > 1e-7f) { sym = 0; break; }
    }
    const int hasCenter = (taps & 1) && sym && off[half] == 0;
    const float wCenter = hasCenter ? wt[half] : 0.0f;

    const int xMin = -minDx > 0 ? -minDx : 0;
    const int xMax = width - maxDx < width ? width - maxDx : width;
    const int yMin = -minDy > 0 ? -minDy : 0;
    const int yMax = height - maxDy < height ? height - maxDy : height;
    const v128_t zero = wasm_f32x4_splat(0.0f);

    // Interior: 64-column vertical strips so multi-row diagonal kernels stay warm in L2 cache.
    if (xMin < xMax && yMin < yMax) {
        const int strip = 64;
        for (int x0 = xMin; x0 < xMax; x0 += strip) {
            const int x1 = x0 + strip < xMax ? x0 + strip : xMax;
            for (int y = yMin; y < yMax; ++y) {
                float *outRow = dst + y * rowStride;
                int x = x0;
                if (sym) {
                    const v128_t vc = wasm_f32x4_splat(wCenter);
                    for (; x + 4 <= x1; x += 4) {
                        const float *base = src + y * rowStride + x * 4;
                        v128_t a0 = hasCenter ? wasm_f32x4_mul(wasm_v128_load(base), vc) : zero;
                        v128_t a1 = hasCenter ? wasm_f32x4_mul(wasm_v128_load(base + 4), vc) : zero;
                        v128_t a2 = hasCenter ? wasm_f32x4_mul(wasm_v128_load(base + 8), vc) : zero;
                        v128_t a3 = hasCenter ? wasm_f32x4_mul(wasm_v128_load(base + 12), vc) : zero;
                        for (int k = 0; k < half; ++k) {
                            v128_t w = wasm_f32x4_splat(wt[k]);
                            int o = off[k];
                            const float *p = base + o, *q = base - o;
                            a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_f32x4_add(wasm_v128_load(p), wasm_v128_load(q)), w));
                            a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_f32x4_add(wasm_v128_load(p + 4), wasm_v128_load(q + 4)), w));
                            a2 = wasm_f32x4_add(a2, wasm_f32x4_mul(wasm_f32x4_add(wasm_v128_load(p + 8), wasm_v128_load(q + 8)), w));
                            a3 = wasm_f32x4_add(a3, wasm_f32x4_mul(wasm_f32x4_add(wasm_v128_load(p + 12), wasm_v128_load(q + 12)), w));
                        }
                        float *o = outRow + x * 4;
                        wasm_v128_store(o, a0);
                        wasm_v128_store(o + 4, a1);
                        wasm_v128_store(o + 8, a2);
                        wasm_v128_store(o + 12, a3);
                    }
                    for (; x < x1; ++x) {
                        const float *base = src + y * rowStride + x * 4;
                        v128_t acc = hasCenter ? wasm_f32x4_mul(wasm_v128_load(base), vc) : zero;
                        for (int k = 0; k < half; ++k) {
                            int o = off[k];
                            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_f32x4_add(wasm_v128_load(base + o), wasm_v128_load(base - o)), wasm_f32x4_splat(wt[k])));
                        }
                        wasm_v128_store(outRow + x * 4, acc);
                    }
                } else {
                    for (; x + 4 <= x1; x += 4) {
                        v128_t a0 = zero, a1 = zero, a2 = zero, a3 = zero;
                        const float *base = src + y * rowStride + x * 4;
                        for (int k = 0; k < taps; ++k) {
                            v128_t w = wasm_f32x4_splat(wt[k]);
                            const float *p = base + off[k];
                            a0 = wasm_f32x4_add(a0, wasm_f32x4_mul(wasm_v128_load(p), w));
                            a1 = wasm_f32x4_add(a1, wasm_f32x4_mul(wasm_v128_load(p + 4), w));
                            a2 = wasm_f32x4_add(a2, wasm_f32x4_mul(wasm_v128_load(p + 8), w));
                            a3 = wasm_f32x4_add(a3, wasm_f32x4_mul(wasm_v128_load(p + 12), w));
                        }
                        float *o = outRow + x * 4;
                        wasm_v128_store(o, a0);
                        wasm_v128_store(o + 4, a1);
                        wasm_v128_store(o + 8, a2);
                        wasm_v128_store(o + 12, a3);
                    }
                    for (; x < x1; ++x) {
                        v128_t acc = zero;
                        const float *base = src + y * rowStride + x * 4;
                        for (int k = 0; k < taps; ++k) {
                            acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(base + off[k]), wasm_f32x4_splat(wt[k])));
                        }
                        wasm_v128_store(outRow + x * 4, acc);
                    }
                }
            }
        }
    }

    // Border pixels
    for (int y = 0; y < height; ++y) {
        const int rowIn = (y >= yMin && y < yMax && xMin < xMax);
        float *outRow = dst + y * rowStride;
        for (int seg = 0; seg < (rowIn ? 2 : 1); ++seg) {
            int s0 = rowIn ? (seg == 0 ? 0 : xMax) : 0;
            int s1 = rowIn ? (seg == 0 ? xMin : width) : width;
            for (int x = s0; x < s1; ++x) {
                v128_t acc = zero;
                for (int k = 0; k < taps; ++k) {
                    int sx = x + dx[k], sy = y + dy[k];
                    if (clamped) {
                        if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
                        if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
                    } else if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
                    acc = wasm_f32x4_add(acc, wasm_f32x4_mul(wasm_v128_load(src + sy * rowStride + sx * 4), wasm_f32x4_splat(wt[k])));
                }
                wasm_v128_store(outRow + x * 4, acc);
            }
        }
    }
    free(off);
}

__attribute__((export_name("web_motion_blur_f32")))
void web_motion_blur_f32(const float *src, float *dst, int width, int height,
                         const int *dx, const int *dy, const float *wt, int taps, int clamped) {
    if (width <= 0 || height <= 0 || taps <= 0) return;
    motion_blur_core_f32(src, dst, width, height, dx, dy, wt, taps, clamped);
}

__attribute__((export_name("web_motion_blur_u8")))
int web_motion_blur_u8(const uint8_t *src, uint8_t *dst, int width, int height,
                       const int *dx, const int *dy, const float *wt, int taps, int clamped) {
    if (width <= 0 || height <= 0 || taps <= 0) return 1;
    size_t total = (size_t)width * (size_t)height * 4;
    float *fsrc = malloc(total * sizeof(float));
    float *fdst = malloc(total * sizeof(float));
    if (!fsrc || !fdst) { free(fsrc); free(fdst); return 0; }
    u8_to_f32(src, fsrc, total);
    motion_blur_core_f32(fsrc, fdst, width, height, dx, dy, wt, taps, clamped);
    f32_to_u8(fdst, dst, total);
    free(fsrc);
    free(fdst);
    return 1;
}

// MARK: Bit-exact separable Gaussian blur for render/effects.ts (float64 accumulation in k = 0..2*r order)

__attribute__((export_name("web_effects_blur_f32")))
int web_effects_blur_f32(const float *src, float *dst, int width, int height, const float *weights, int radius) {
    if (width <= 0 || height <= 0 || radius <= 0) return 1;
    const int taps = radius * 2 + 1;
    size_t total = (size_t)width * (size_t)height;
    float *temp = calloc(total, sizeof(float));
    uint8_t *rowLive = calloc((size_t)height, 1);
    if (!temp || !rowLive) { free(temp); free(rowLive); return 0; }

    for (int y = 0; y < height; ++y) {
        const float *inRow = src + (size_t)y * width;
        int minX = 0;
        while (minX < width && inRow[minX] == 0.0f) ++minX;
        if (minX == width) continue;
        int maxX = width - 1;
        while (maxX > minX && inRow[maxX] == 0.0f) --maxX;
        rowLive[y] = 1;
        float *outRow = temp + (size_t)y * width;
        const int xs = minX - radius > 0 ? minX - radius : 0;
        const int xe = maxX + radius + 1 < width ? maxX + radius + 1 : width;
        const int inLo = radius > xs ? radius : xs;
        const int inHi = width - radius < xe ? width - radius : xe;
        int x = xs;
        for (; x < inLo; ++x) {
            double v = 0.0;
            for (int k = -radius; k <= radius; ++k) {
                int sx = x + k;
                if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
                v += (double)inRow[sx] * (double)weights[k + radius];
            }
            outRow[x] = (float)v;
        }
        for (; x + 2 <= inHi; x += 2) {
            v128_t acc = wasm_f64x2_splat(0.0);
            const float *p = inRow + x - radius;
            for (int k = 0; k < taps; ++k) {
                v128_t pair = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(p + k));
                acc = wasm_f64x2_add(acc, wasm_f64x2_mul(pair, wasm_f64x2_splat((double)weights[k])));
            }
            v128_t f = wasm_f32x4_demote_f64x2_zero(acc);
            wasm_v128_store64_lane(outRow + x, f, 0);
        }
        for (; x < inHi; ++x) {
            double v = 0.0;
            const float *p = inRow + x - radius;
            for (int k = 0; k < taps; ++k) v += (double)p[k] * (double)weights[k];
            outRow[x] = (float)v;
        }
        for (; x < xe; ++x) {
            double v = 0.0;
            for (int k = -radius; k <= radius; ++k) {
                int sx = x + k;
                if (sx < 0) sx = 0; else if (sx >= width) sx = width - 1;
                v += (double)inRow[sx] * (double)weights[k + radius];
            }
            outRow[x] = (float)v;
        }
    }

    double acc[64];
    for (int y = 0; y < height; ++y) {
        int any = 0;
        for (int k = -radius; k <= radius; ++k) {
            int sy = y + k;
            if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
            if (rowLive[sy]) { any = 1; break; }
        }
        float *outRow = dst + (size_t)y * width;
        if (!any) { memset(outRow, 0, (size_t)width * sizeof(float)); continue; }
        for (int x0 = 0; x0 < width; x0 += 64) {
            int len = width - x0 < 64 ? width - x0 : 64;
            memset(acc, 0, (size_t)len * sizeof(double));
            for (int k = -radius; k <= radius; ++k) {
                int sy = y + k;
                if (sy < 0) sy = 0; else if (sy >= height) sy = height - 1;
                if (!rowLive[sy]) continue;
                const double wk = (double)weights[k + radius];
                const v128_t vw = wasm_f64x2_splat(wk);
                const float *inRow = temp + (size_t)sy * width + x0;
                int j = 0;
                for (; j + 4 <= len; j += 4) {
                    v128_t v = wasm_v128_load(inRow + j);
                    v128_t a0 = wasm_v128_load(acc + j);
                    v128_t a1 = wasm_v128_load(acc + j + 2);
                    a0 = wasm_f64x2_add(a0, wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(v), vw));
                    a1 = wasm_f64x2_add(a1, wasm_f64x2_mul(wasm_f64x2_promote_low_f32x4(wasm_i64x2_shuffle(v, v, 1, 1)), vw));
                    wasm_v128_store(acc + j, a0);
                    wasm_v128_store(acc + j + 2, a1);
                }
                for (; j < len; ++j) acc[j] += (double)inRow[j] * wk;
            }
            int j = 0;
            for (; j + 4 <= len; j += 4) {
                v128_t lo2 = wasm_f32x4_demote_f64x2_zero(wasm_v128_load(acc + j));
                v128_t hi2 = wasm_f32x4_demote_f64x2_zero(wasm_v128_load(acc + j + 2));
                wasm_v128_store(outRow + x0 + j, wasm_i64x2_shuffle(lo2, hi2, 0, 2));
            }
            for (; j < len; ++j) outRow[x0 + j] = (float)acc[j];
        }
    }
    free(temp);
    free(rowLive);
    return 1;
}

// MARK: Separable float32 Gaussian convolution for lensEffects.ts (convRows + convColumns)

__attribute__((export_name("web_gauss_sep_f32")))
int web_gauss_sep_f32(const float *src, float *dst, int width, int height,
                      const float *gx, int kx, const float *gy, int ky, int clamp) {
    if (width <= 0 || height <= 0) return 1;
    size_t total = (size_t)width * (size_t)height;
    float *mid = ky > 0 ? calloc(total, sizeof(float)) : dst;
    uint8_t *rowLive = calloc((size_t)height, 1);
    float *rowBuf = kx > 0 ? malloc((size_t)(width + 2 * kx) * sizeof(float)) : NULL;
    if (!mid || !rowLive || (kx > 0 && !rowBuf)) {
        if (ky > 0) free(mid);
        free(rowLive);
        free(rowBuf);
        return 0;
    }

    if (kx > 0) {
        for (int y = 0; y < height; ++y) {
            const float *inRow = src + (size_t)y * width;
            int lo = 0;
            while (lo < width && inRow[lo] == 0.0f) ++lo;
            if (lo == width) {
                if (ky == 0) memset(mid + (size_t)y * width, 0, (size_t)width * sizeof(float));
                continue;
            }
            int hi = width - 1;
            while (hi > lo && inRow[hi] == 0.0f) --hi;
            rowLive[y] = 1;
            float leftVal = clamp ? inRow[0] : 0.0f;
            float rightVal = clamp ? inRow[width - 1] : 0.0f;
            for (int k = 0; k < kx; ++k) rowBuf[k] = leftVal;
            memcpy(rowBuf + kx, inRow, (size_t)width * sizeof(float));
            for (int k = 0; k < kx; ++k) rowBuf[kx + width + k] = rightVal;
            float *outRow = mid + (size_t)y * width;
            int x0 = clamp ? 0 : (lo - kx > 0 ? lo - kx : 0);
            int x1 = clamp ? width : (hi + kx + 1 < width ? hi + kx + 1 : width);
            if (ky == 0) {
                if (x0 > 0) memset(outRow, 0, (size_t)x0 * sizeof(float));
                if (x1 < width) memset(outRow + x1, 0, (size_t)(width - x1) * sizeof(float));
            }
            const v128_t gCenter = wasm_f32x4_splat(gx[kx]);
            int x = x0;
            for (; x + 4 <= x1; x += 4) {
                v128_t s = wasm_f32x4_mul(gCenter, wasm_v128_load(rowBuf + x + kx));
                const float *lp = rowBuf + x;
                const float *rp = rowBuf + x + 2 * kx;
                for (int k = 0; k < kx; ++k) {
                    v128_t gk = wasm_f32x4_splat(gx[k]);
                    s = wasm_f32x4_add(s, wasm_f32x4_mul(gk, wasm_f32x4_add(wasm_v128_load(lp + k), wasm_v128_load(rp - k))));
                }
                wasm_v128_store(outRow + x, s);
            }
            for (; x < x1; ++x) {
                float s = gx[kx] * rowBuf[x + kx];
                for (int k = 0, e = x + 2 * kx; k < kx; ++k) s += gx[k] * (rowBuf[x + k] + rowBuf[e - k]);
                outRow[x] = s;
            }
        }
    } else {
        memcpy(mid, src, total * sizeof(float));
        for (int y = 0; y < height; ++y) {
            const float *inRow = mid + (size_t)y * width;
            for (int x = 0; x < width; ++x) if (inRow[x] != 0.0f) { rowLive[y] = 1; break; }
        }
    }

    if (ky > 0) {
        for (int y = 0; y < height; ++y) {
            float *outRow = dst + (size_t)y * width;
            memset(outRow, 0, (size_t)width * sizeof(float));
            for (int k = -ky; k <= ky; ++k) {
                int j = y + k;
                if (j < 0 || j >= height) {
                    if (!clamp) continue;
                    j = j < 0 ? 0 : height - 1;
                }
                if (!rowLive[j]) continue;
                const float gk = gy[k + ky];
                const v128_t vg = wasm_f32x4_splat(gk);
                const float *inRow = mid + (size_t)j * width;
                int x = 0;
                for (; x + 4 <= width; x += 4) {
                    wasm_v128_store(outRow + x, wasm_f32x4_add(wasm_v128_load(outRow + x), wasm_f32x4_mul(vg, wasm_v128_load(inRow + x))));
                }
                for (; x < width; ++x) outRow[x] += gk * inRow[x];
            }
        }
        free(mid);
    }
    free(rowLive);
    free(rowBuf);
    return 1;
}

// MARK: RGB Split SIMD128 pass (Linear & Radial, Streaks & Spectrum)
// Uses 128-bit adjacent pair loads (2 RGBA u16 pixels per load) + 3-lerp bilinear + packed float4 tints.

static inline __attribute__((always_inline)) v128_t load_u16x4_as_f32x4(const uint16_t *p) {
    return wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(wasm_v128_load64_zero(p)));
}

// Fast bilinear for two adjacent rows of two adjacent u16 RGBA pixels (only 2 128-bit loads!).
static inline __attribute__((always_inline)) v128_t bilerp_u16x4_adj(const uint16_t *top, const uint16_t *bot, float fx, float fy) {
    v128_t r0 = wasm_v128_load(top);
    v128_t r1 = wasm_v128_load(bot);
    v128_t p00 = wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(r0));
    v128_t p10 = wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(r0));
    v128_t p01 = wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(r1));
    v128_t p11 = wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(r1));
    v128_t vfx = wasm_f32x4_splat(fx);
    v128_t t = wasm_f32x4_add(p00, wasm_f32x4_mul(wasm_f32x4_sub(p10, p00), vfx));
    v128_t b = wasm_f32x4_add(p01, wasm_f32x4_mul(wasm_f32x4_sub(p11, p01), vfx));
    return wasm_f32x4_add(t, wasm_f32x4_mul(wasm_f32x4_sub(b, t), wasm_f32x4_splat(fy)));
}

static inline __attribute__((always_inline)) v128_t bilerp_u16x4_w4(const uint16_t *top, const uint16_t *bot, const float *w4) {
    v128_t r0 = wasm_v128_load(top);
    v128_t r1 = wasm_v128_load(bot);
    v128_t v = wasm_f32x4_mul(wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(r0)), wasm_f32x4_splat(w4[0]));
    v = wasm_f32x4_add(v, wasm_f32x4_mul(wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(r0)), wasm_f32x4_splat(w4[1])));
    v = wasm_f32x4_add(v, wasm_f32x4_mul(wasm_f32x4_convert_u32x4(wasm_u32x4_extend_low_u16x8(r1)), wasm_f32x4_splat(w4[2])));
    v = wasm_f32x4_add(v, wasm_f32x4_mul(wasm_f32x4_convert_u32x4(wasm_u32x4_extend_high_u16x8(r1)), wasm_f32x4_splat(w4[3])));
    return v;
}

static inline __attribute__((always_inline)) v128_t bilerp_u16x4_gen(const uint16_t *p00, const uint16_t *p10,
                                                                     const uint16_t *p01, const uint16_t *p11,
                                                                     float fx, float fy) {
    v128_t a = load_u16x4_as_f32x4(p00);
    v128_t b = load_u16x4_as_f32x4(p10);
    v128_t c = load_u16x4_as_f32x4(p01);
    v128_t d = load_u16x4_as_f32x4(p11);
    v128_t vfx = wasm_f32x4_splat(fx);
    v128_t t = wasm_f32x4_add(a, wasm_f32x4_mul(wasm_f32x4_sub(b, a), vfx));
    v128_t bt = wasm_f32x4_add(c, wasm_f32x4_mul(wasm_f32x4_sub(d, c), vfx));
    return wasm_f32x4_add(t, wasm_f32x4_mul(wasm_f32x4_sub(bt, t), wasm_f32x4_splat(fy)));
}

static inline __attribute__((always_inline)) void write_rgb_pixel(int mode, void *outBuf, size_t outIdx,
                                                                  v128_t col, v128_t alp, int opaque, int level,
                                                                  const float *totals, int n) {
    if (mode == 0) {
        uint16_t *dst = (uint16_t *)outBuf + outIdx;
        v128_t scaled = wasm_f32x4_add(wasm_f32x4_mul(col, wasm_f32x4_splat(1.0f / (float)n)), wasm_f32x4_splat(0.5f));
        v128_t u = wasm_u16x8_narrow_i32x4(wasm_i32x4_trunc_sat_f32x4(scaled), wasm_i32x4_splat(0));
        wasm_v128_store64_lane(dst, u, 0);
        return;
    }
    uint8_t *dst = (uint8_t *)outBuf + outIdx;
    const float *tot = totals + level * 4;
    float tr = tot[0] * 256.0f, tg = tot[1] * 256.0f, tb = tot[2] * 256.0f;
    float ar, ag, ab;
    if (opaque) {
        ar = alp[0] * 255.0f / tot[0];
        ag = alp[1] * 255.0f / tot[1];
        ab = alp[2] * 255.0f / tot[2];
    } else {
        ar = alp[0] / tr;
        ag = alp[1] / tg;
        ab = alp[2] / tb;
    }
    float most = ar > ag ? (ar > ab ? ar : ab) : (ag > ab ? ag : ab);
    float a = most < 255.0f ? most : 255.0f;
    float cr = col[0] / tr, cg = col[1] / tg, cb = col[2] / tb;
    dst[0] = (uint8_t)(int)((cr < a ? cr : a) + 0.5f);
    dst[1] = (uint8_t)(int)((cg < a ? cg : a) + 0.5f);
    dst[2] = (uint8_t)(int)((cb < a ? cb : a) + 0.5f);
    dst[3] = (uint8_t)(int)(a + 0.5f);
}

// tints4: 4 floats per tap [r, g, b, 0]; totals4: 4 floats per level [tr, tg, tb, 0].
__attribute__((export_name("web_rgb_split_sweep")))
void web_rgb_split_sweep(
    const uint16_t *input, int iw, int ih, int origin, int sides, int opaque,
    void *outBuf, int w, int h, int at, int mode,
    const uint8_t *lv, int lw,
    int n, const float *along, const float *tints4, const float *totals4,
    int radial, float cx, float cy, float reach, float dx, float dy, float scale, float extent,
    int useGrid, const int *offsets, const float *weights, const float *pairs, int step,
    const int *spans
) {
    const int irow = iw * 4;
    const int last = iw - 1, bottom = ih - 1;
    const int strip = radial ? 32 : 64;
    const float lox = (sides & 1) ? -1e30f : -0.5f;
    const float hix = (sides & 2) ? 1e30f : (float)iw - 0.5f;
    const float loy = (sides & 4) ? -1e30f : -0.5f;
    const float hiy = (sides & 8) ? 1e30f : (float)ih - 0.5f;
    const int clip = sides != 15;
    const v128_t zero = wasm_f32x4_splat(0.0f);
    // In both streaks (step = 1/n) and spectrum (step = 2/n when n > 1), along[k] increases uniformly per tap.
    const float alongStep = mode == 0 ? (1.0f / (float)n) : (n > 1 ? 2.0f / (float)n : 0.0f);

    for (int x0 = 0; x0 < w; x0 += strip) {
        for (int y = 0; y < h; ++y) {
            int xs = spans ? (x0 > spans[y * 2] ? x0 : spans[y * 2]) : x0;
            int xe = x0 + strip < w ? x0 + strip : w;
            if (spans && spans[y * 2 + 1] < xe) xe = spans[y * 2 + 1];
            if (xs >= xe) continue;

            const float ay = (float)(y + at) + 0.5f;
            const float oy = ay - (float)origin - 0.5f;
            const int li = y * lw;
            const size_t outRow = (size_t)y * (size_t)w * 4;

            int a = xs, b = xe;
            if (!radial) {
                float ex = fabsf(dx * scale) * extent;
                float ey = fabsf(dy * scale) * extent;
                if (ay - ey - (float)origin >= 0.5f && ay + ey - (float)origin < (float)ih - 0.5f) {
                    float minAx = 0.5f + ex + (float)origin;
                    float maxAx = (float)iw - 0.5f - ex + (float)origin;
                    while (a < xe && ((float)(a + at) + 0.5f) < minAx) ++a;
                    while (b > a && ((float)(b - 1 + at) + 0.5f) >= maxAx) --b;
                } else {
                    a = xe; b = xe;
                }
            } else {
                while (a < xe) {
                    float ax = (float)(a + at) + 0.5f;
                    float ex = fabsf((ax - cx) / reach * scale) * extent;
                    float ey = fabsf((ay - cy) / reach * scale) * extent;
                    if (ax - ex - (float)origin >= 0.5f && ax + ex - (float)origin < (float)iw - 0.5f &&
                        ay - ey - (float)origin >= 0.5f && ay + ey - (float)origin < (float)ih - 0.5f) break;
                    ++a;
                }
                while (b > a) {
                    float ax = (float)(b - 1 + at) + 0.5f;
                    float ex = fabsf((ax - cx) / reach * scale) * extent;
                    float ey = fabsf((ay - cy) / reach * scale) * extent;
                    if (ax - ex - (float)origin >= 0.5f && ax + ex - (float)origin < (float)iw - 0.5f &&
                        ay - ey - (float)origin >= 0.5f && ay + ey - (float)origin < (float)ih - 0.5f) break;
                    --b;
                }
            }

            if (useGrid && a < b) {
                int baseAt = (y + at - origin) * irow + (a + at - origin) * 4;
                for (int x = a; x < b; ++x, baseAt += 4) {
                    int level = lv[li + x];
                    int first = level * n, end = first + n;
                    v128_t col = zero, alp = zero;
                    if (mode == 0) {
                        if (step) {
                            for (int k = first; k < end; ++k) {
                                const uint16_t *p = input + baseAt + offsets[k];
                                col = wasm_f32x4_add(col, wasm_f32x4_add(
                                    wasm_f32x4_mul(load_u16x4_as_f32x4(p), wasm_f32x4_splat(pairs[k * 2])),
                                    wasm_f32x4_mul(load_u16x4_as_f32x4(p + step), wasm_f32x4_splat(pairs[k * 2 + 1]))));
                            }
                        } else {
                            for (int k = first; k < end; ++k) {
                                const uint16_t *p = input + baseAt + offsets[k];
                                col = wasm_f32x4_add(col, bilerp_u16x4_w4(p, p + irow, weights + k * 4));
                            }
                        }
                    } else if (step) {
                        for (int k = first; k < end; ++k) {
                            const uint16_t *p = input + baseAt + offsets[k];
                            v128_t s = wasm_f32x4_add(
                                wasm_f32x4_mul(load_u16x4_as_f32x4(p), wasm_f32x4_splat(pairs[k * 2])),
                                wasm_f32x4_mul(load_u16x4_as_f32x4(p + step), wasm_f32x4_splat(pairs[k * 2 + 1])));
                            v128_t tv = wasm_v128_load(tints4 + k * 4);
                            col = wasm_f32x4_add(col, wasm_f32x4_mul(s, tv));
                            if (!opaque) alp = wasm_f32x4_add(alp, wasm_f32x4_mul(wasm_i32x4_shuffle(s, s, 3, 3, 3, 3), tv));
                        }
                        if (opaque) alp = wasm_v128_load(totals4 + level * 4);
                    } else {
                        for (int k = first; k < end; ++k) {
                            const uint16_t *p = input + baseAt + offsets[k];
                            v128_t s = bilerp_u16x4_w4(p, p + irow, weights + k * 4);
                            v128_t tv = wasm_v128_load(tints4 + k * 4);
                            col = wasm_f32x4_add(col, wasm_f32x4_mul(s, tv));
                            if (!opaque) alp = wasm_f32x4_add(alp, wasm_f32x4_mul(wasm_i32x4_shuffle(s, s, 3, 3, 3, 3), tv));
                        }
                        if (opaque) alp = wasm_v128_load(totals4 + level * 4);
                    }
                    write_rgb_pixel(mode, outBuf, outRow + (size_t)x * 4, col, alp, opaque, level, totals4, n);
                }
            } else if (a < b) {
                const float vyConst = radial ? (ay - cy) / reach * scale : dy * scale;
                const float dsy = vyConst * alongStep;
                for (int x = a; x < b; ++x) {
                    int level = lv[li + x];
                    int first = level * n, end = first + n;
                    float ax = (float)(x + at) + 0.5f;
                    float ox = ax - (float)origin - 0.5f;
                    float vx = radial ? (ax - cx) / reach * scale : dx * scale;
                    float dsx = vx * alongStep;
                    float a0 = along[first];
                    float sx = ox - vx * a0, sy = oy - vyConst * a0;
                    v128_t col = zero, alp = zero;
                    if (mode == 0) {
                        for (int k = first; k < end; ++k) {
                            int ix = (int)sx, iy = (int)sy;
                            const uint16_t *p = input + iy * irow + (ix << 2);
                            col = wasm_f32x4_add(col, bilerp_u16x4_adj(p, p + irow, sx - (float)ix, sy - (float)iy));
                            sx -= dsx; sy -= dsy;
                        }
                    } else if (opaque) {
                        for (int k = first; k < end; ++k) {
                            int ix = (int)sx, iy = (int)sy;
                            const uint16_t *p = input + iy * irow + (ix << 2);
                            v128_t s = bilerp_u16x4_adj(p, p + irow, sx - (float)ix, sy - (float)iy);
                            col = wasm_f32x4_add(col, wasm_f32x4_mul(s, wasm_v128_load(tints4 + k * 4)));
                            sx -= dsx; sy -= dsy;
                        }
                        alp = wasm_v128_load(totals4 + level * 4);
                    } else {
                        for (int k = first; k < end; ++k) {
                            int ix = (int)sx, iy = (int)sy;
                            const uint16_t *p = input + iy * irow + (ix << 2);
                            v128_t s = bilerp_u16x4_adj(p, p + irow, sx - (float)ix, sy - (float)iy);
                            v128_t tv = wasm_v128_load(tints4 + k * 4);
                            col = wasm_f32x4_add(col, wasm_f32x4_mul(s, tv));
                            alp = wasm_f32x4_add(alp, wasm_f32x4_mul(wasm_i32x4_shuffle(s, s, 3, 3, 3, 3), tv));
                            sx -= dsx; sy -= dsy;
                        }
                    }
                    write_rgb_pixel(mode, outBuf, outRow + (size_t)x * 4, col, alp, opaque, level, totals4, n);
                }
            }

            const float vyConst = radial ? (ay - cy) / reach * scale : dy * scale;
            const float dsy = vyConst * alongStep;
            for (int seg = 0; seg < 2; ++seg) {
                int s0 = seg == 0 ? xs : b;
                int s1 = seg == 0 ? a : xe;
                for (int x = s0; x < s1; ++x) {
                    int level = lv[li + x];
                    int first = level * n, end = first + n;
                    float ax = (float)(x + at) + 0.5f;
                    float ox = ax - (float)origin - 0.5f;
                    float vx = radial ? (ax - cx) / reach * scale : dx * scale;
                    float dsx = vx * alongStep;
                    float a0 = along[first];
                    float sx = ox - vx * a0, sy = oy - vyConst * a0;
                    v128_t col = zero, alp = zero;
                    for (int k = first; k < end; ++k) {
                        if (!(clip && (sx < lox || sx > hix || sy < loy || sy > hiy))) {
                            float xc = sx < 0.0f ? 0.0f : (sx > (float)last ? (float)last : sx);
                            float yc = sy < 0.0f ? 0.0f : (sy > (float)bottom ? (float)bottom : sy);
                            int ix = (int)xc, iy = (int)yc;
                            const uint16_t *p = input + iy * irow + (ix << 2);
                            const uint16_t *q = iy < bottom ? p + irow : p;
                            const uint16_t *r = ix < last ? p + 4 : p;
                            const uint16_t *u = ix < last ? q + 4 : q;
                            v128_t s = bilerp_u16x4_gen(p, r, q, u, xc - (float)ix, yc - (float)iy);
                            if (mode == 0) {
                                col = wasm_f32x4_add(col, s);
                            } else {
                                v128_t tv = wasm_v128_load(tints4 + k * 4);
                                col = wasm_f32x4_add(col, wasm_f32x4_mul(s, tv));
                                if (opaque) alp = wasm_f32x4_add(alp, tv);
                                else alp = wasm_f32x4_add(alp, wasm_f32x4_mul(wasm_i32x4_shuffle(s, s, 3, 3, 3, 3), tv));
                            }
                        }
                        sx -= dsx; sy -= dsy;
                    }
                    write_rgb_pixel(mode, outBuf, outRow + (size_t)x * 4, col, alp, opaque, level, totals4, n);
                }
            }
        }
    }
}

// MARK: Volumetric Light beam gathering (96-tap radial ray march, 4 pixels at a time in f32x4 SIMD)

__attribute__((export_name("web_volumetric_gather")))
void web_volumetric_gather(const float *emission, float *gathered, const float *weight,
                           int bw, int bh, float lx, float ly, float length, int samples) {
    if (bw <= 0 || bh <= 0 || samples <= 0) return;
    if (length == 0.0f) {
        double wsum = 0.0;
        for (int k = 0; k < samples; ++k) wsum += (double)weight[k];
        float factor = (float)(wsum / samples * 4.0);
        int total = bw * bh;
        for (int i = 0; i < total; ++i) gathered[i] = emission[i] * factor;
        return;
    }
    const float invSamples = 1.0f / (float)samples;
    const float scaleOut = 4.0f * invSamples;
    const float maxX = (float)(bw - 1), maxY = (float)(bh - 1);
    const v128_t vScaleOut = wasm_f32x4_splat(scaleOut);
    const v128_t vBw = wasm_i32x4_splat(bw);
    const float lenInv = length * invSamples;
    const float spanN = (float)(samples - 1);

    for (int y = 0; y < bh; ++y) {
        const float hy = (float)y + 0.5f;
        const float stepY = (ly - hy) * lenInv;
        const double yHash = (double)y * 1.414;
        float *outRow = gathered + y * bw;
        int x = 0;
        for (; x + 4 <= bw; x += 4) {
            float fx0[4], fy0[4], sx[4];
            int allIn = 1;
            for (int lane = 0; lane < 4; ++lane) {
                float hx = (float)(x + lane) + 0.5f;
                float stepX = (lx - hx) * lenInv;
                double hv = sin(((double)(x + lane) * 0.618 + yHash) * 12.9898) * 43758.5453;
                float jitter = (float)(hv - floor(hv));
                float fx = hx + stepX * jitter - 0.5f;
                float fy = hy + stepY * jitter - 0.5f;
                float ex = fx + stepX * spanN;
                float ey = fy + stepY * spanN;
                fx0[lane] = fx; fy0[lane] = fy; sx[lane] = stepX;
                if (!(fx >= 0.0f && fx < maxX && fy >= 0.0f && fy < maxY &&
                      ex >= 0.0f && ex < maxX && ey >= 0.0f && ey < maxY)) allIn = 0;
            }
            if (allIn) {
                v128_t vfx = wasm_v128_load(fx0);
                v128_t vfy = wasm_v128_load(fy0);
                v128_t vsx = wasm_v128_load(sx);
                v128_t vsy = wasm_f32x4_splat(stepY);
                v128_t vsum = wasm_f32x4_splat(0.0f);
                for (int k = 0; k < samples; ++k) {
                    v128_t vx0 = wasm_i32x4_trunc_sat_f32x4(vfx);
                    v128_t vy0 = wasm_i32x4_trunc_sat_f32x4(vfy);
                    v128_t vtx = wasm_f32x4_sub(vfx, wasm_f32x4_convert_i32x4(vx0));
                    v128_t vty = wasm_f32x4_sub(vfy, wasm_f32x4_convert_i32x4(vy0));
                    v128_t vj = wasm_i32x4_add(wasm_i32x4_mul(vy0, vBw), vx0);
                    int j0 = wasm_i32x4_extract_lane(vj, 0);
                    int j1 = wasm_i32x4_extract_lane(vj, 1);
                    int j2 = wasm_i32x4_extract_lane(vj, 2);
                    int j3 = wasm_i32x4_extract_lane(vj, 3);
                    v128_t e00 = wasm_f32x4_make(emission[j0], emission[j1], emission[j2], emission[j3]);
                    v128_t e10 = wasm_f32x4_make(emission[j0 + 1], emission[j1 + 1], emission[j2 + 1], emission[j3 + 1]);
                    v128_t e01 = wasm_f32x4_make(emission[j0 + bw], emission[j1 + bw], emission[j2 + bw], emission[j3 + bw]);
                    v128_t e11 = wasm_f32x4_make(emission[j0 + bw + 1], emission[j1 + bw + 1], emission[j2 + bw + 1], emission[j3 + bw + 1]);
                    v128_t top = wasm_f32x4_add(e00, wasm_f32x4_mul(wasm_f32x4_sub(e10, e00), vtx));
                    v128_t bot = wasm_f32x4_add(e01, wasm_f32x4_mul(wasm_f32x4_sub(e11, e01), vtx));
                    v128_t val = wasm_f32x4_add(top, wasm_f32x4_mul(wasm_f32x4_sub(bot, top), vty));
                    vsum = wasm_f32x4_add(vsum, wasm_f32x4_mul(val, wasm_f32x4_splat(weight[k])));
                    vfx = wasm_f32x4_add(vfx, vsx);
                    vfy = wasm_f32x4_add(vfy, vsy);
                }
                wasm_v128_store(outRow + x, wasm_f32x4_mul(vsum, vScaleOut));
            } else {
                for (int lane = 0; lane < 4; ++lane) {
                    float fx = fx0[lane], fy = fy0[lane], stepX = sx[lane], sum = 0.0f;
                    for (int k = 0; k < samples; ++k) {
                        float cx = fx < 0.0f ? 0.0f : (fx > maxX ? maxX : fx);
                        float cy = fy < 0.0f ? 0.0f : (fy > maxY ? maxY : fy);
                        int x0 = (int)cx, y0 = (int)cy;
                        int x1 = x0 + 1 < bw ? x0 + 1 : bw - 1;
                        int y1 = y0 + 1 < bh ? y0 + 1 : bh - 1;
                        float tx = cx - (float)x0, ty = cy - (float)y0;
                        int r0 = y0 * bw, r1 = y1 * bw;
                        float top = emission[r0 + x0] + (emission[r0 + x1] - emission[r0 + x0]) * tx;
                        float bot = emission[r1 + x0] + (emission[r1 + x1] - emission[r1 + x0]) * tx;
                        sum += (top + (bot - top) * ty) * weight[k];
                        fx += stepX; fy += stepY;
                    }
                    outRow[x + lane] = sum * scaleOut;
                }
            }
        }
        for (; x < bw; ++x) {
            float hx = (float)x + 0.5f, stepX = (lx - hx) * lenInv;
            double hv = sin(((double)x * 0.618 + yHash) * 12.9898) * 43758.5453;
            float jitter = (float)(hv - floor(hv));
            float fx = hx + stepX * jitter - 0.5f, fy = hy + stepY * jitter - 0.5f, sum = 0.0f;
            for (int k = 0; k < samples; ++k) {
                float cx = fx < 0.0f ? 0.0f : (fx > maxX ? maxX : fx);
                float cy = fy < 0.0f ? 0.0f : (fy > maxY ? maxY : fy);
                int x0 = (int)cx, y0 = (int)cy;
                int x1 = x0 + 1 < bw ? x0 + 1 : bw - 1;
                int y1 = y0 + 1 < bh ? y0 + 1 : bh - 1;
                float tx = cx - (float)x0, ty = cy - (float)y0;
                int r0 = y0 * bw, r1 = y1 * bw;
                float top = emission[r0 + x0] + (emission[r0 + x1] - emission[r0 + x0]) * tx;
                float bot = emission[r1 + x0] + (emission[r1 + x1] - emission[r1 + x0]) * tx;
                sum += (top + (bot - top) * ty) * weight[k];
                fx += stepX; fy += stepY;
            }
            outRow[x] = sum * scaleOut;
        }
    }
}
