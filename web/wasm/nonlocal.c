#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <wasm_simd128.h>
#include "AdjustPixels.h"

// The web's `nonlocal_means` (AdjustPixels.c), installed as `adjust_nonlocal_means_gpu` since the browser has one thread
// and no Metal. The same weights, worked in tiles that stay in cache, four pixels at a time, each offset's patch distances
// serving the opposite offset too: the distance from p to p + o is the one from p + o to p. Clamping at the picture's
// edges breaks that, so the frame a patch wide around it is worked offset by offset as the C does.

enum { steps = 1024, tileRows = 128, tileColumns = 256 };
static float table[steps + 1];

typedef struct {
    const float *luma, *coverage;
    float *out;
    long width, height;
    int search, patch;
    float allowance, toStep, area;
} Means;

static long clamp_index(long index, long limit) { return index < 0 ? 0 : index >= limit ? limit - 1 : index; }

static float weight_for(const Means *m, float sum) {
    float scaled = (sum / m->area - m->allowance) * m->toStep;
    if (!(scaled < steps)) return 0;
    return table[scaled <= 0 ? 0 : (int)scaled];
}

static void finish(const Means *m, long y0, long y1, long x0, long x1, const float *total, const float *weights, const float *strongest, long origin, long pitch) {
    for (long y = y0; y < y1; ++y) {
        for (long x = x0; x < x1; ++x) {
            long index = origin + (y - y0) * pitch + (x - x0), pixel = y * m->width + x;
            float own = strongest[index] > 0 ? strongest[index] : 1;
            m->out[pixel] = (total[index] + own * m->luma[pixel]) / (weights[index] + own);
        }
    }
}

static size_t tile_floats(int search, int patch) {
    long top = search + patch, left = 2 * search + patch, lanes = (tileColumns + 7) & ~7;
    long count = (lanes + 2 * search + 7) & ~7, span = (count + 2 * patch + 3) & ~3;
    return 2 * (tileRows + 2 * top) * (tileColumns + 2 * left + 24) + 3 * tileRows * lanes + (2 * search + 1) * (count + span);
}

static inline __attribute__((always_inline)) void column_add(float *column, const float *row, long shift, long span) {
    for (long c = 0; c < span; c += 4) {
        v128_t d = wasm_f32x4_sub(wasm_v128_load(row + c), wasm_v128_load(row + c + shift));
        wasm_v128_store(column + c, wasm_f32x4_add(wasm_v128_load(column + c), wasm_f32x4_mul(d, d)));
    }
}

static inline __attribute__((always_inline)) void column_slide(float *column, const float *entering, const float *leaving, long shift, long span) {
    for (long c = 0; c < span; c += 4) {
        v128_t in = wasm_f32x4_sub(wasm_v128_load(entering + c), wasm_v128_load(entering + c + shift));
        v128_t out = wasm_f32x4_sub(wasm_v128_load(leaving + c), wasm_v128_load(leaving + c + shift));
        wasm_v128_store(column + c, wasm_f32x4_sub(wasm_f32x4_add(wasm_v128_load(column + c), wasm_f32x4_mul(in, in)), wasm_f32x4_mul(out, out)));
    }
}

static inline __attribute__((always_inline)) void weight_row(const Means *m, float *into, const float *column, long count, const int window) {
    const v128_t inverseArea = wasm_f32x4_splat(1 / m->area), allowance = wasm_f32x4_splat(m->allowance), toStep = wasm_f32x4_splat(m->toStep);
    const v128_t zero = wasm_i32x4_splat(0), last = wasm_i32x4_splat(steps);
    for (long j = 0; j < count; j += 8) {
        v128_t sum0 = wasm_v128_load(column + j), sum1 = wasm_v128_load(column + j + 4);
        for (int t = 1; t < window; ++t) {
            sum0 = wasm_f32x4_add(sum0, wasm_v128_load(column + j + t));
            sum1 = wasm_f32x4_add(sum1, wasm_v128_load(column + j + 4 + t));
        }
        v128_t step0 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(sum0, inverseArea), allowance), toStep));
        v128_t step1 = wasm_i32x4_trunc_sat_f32x4(wasm_f32x4_mul(wasm_f32x4_sub(wasm_f32x4_mul(sum1, inverseArea), allowance), toStep));
        step0 = wasm_i32x4_min(wasm_i32x4_max(step0, zero), last);
        step1 = wasm_i32x4_min(wasm_i32x4_max(step1, zero), last);
        wasm_v128_store(into + j, wasm_f32x4_make(table[wasm_i32x4_extract_lane(step0, 0)], table[wasm_i32x4_extract_lane(step0, 1)],
                                                  table[wasm_i32x4_extract_lane(step0, 2)], table[wasm_i32x4_extract_lane(step0, 3)]));
        wasm_v128_store(into + j + 4, wasm_f32x4_make(table[wasm_i32x4_extract_lane(step1, 0)], table[wasm_i32x4_extract_lane(step1, 1)],
                                                      table[wasm_i32x4_extract_lane(step1, 2)], table[wasm_i32x4_extract_lane(step1, 3)]));
    }
}

// Adds a group of offsets' weights to a row of pixels, each offset's weights `weightStep` on and neighbors `step` on.
static inline __attribute__((always_inline)) void gather_row(float *total, long size, long lanes, const float *weights, long weightStep,
                                                             const float *neighbors, long toCoverage, int group, int step, const int opaque) {
    for (long k = 0; k < lanes; k += 8) {
        float *t = total + k;
        v128_t sum0 = wasm_v128_load(t), weight0 = wasm_v128_load(t + size), strongest0 = wasm_v128_load(t + 2 * size);
        v128_t sum1 = wasm_v128_load(t + 4), weight1 = wasm_v128_load(t + size + 4), strongest1 = wasm_v128_load(t + 2 * size + 4);
        for (int g = 0; g < group; ++g) {
            const float *neighbor = neighbors + g * step + k, *w = weights + g * weightStep + k;
            v128_t w0 = opaque ? wasm_v128_load(w) : wasm_f32x4_mul(wasm_v128_load(w), wasm_v128_load(neighbor + toCoverage));
            v128_t w1 = opaque ? wasm_v128_load(w + 4) : wasm_f32x4_mul(wasm_v128_load(w + 4), wasm_v128_load(neighbor + toCoverage + 4));
            sum0 = wasm_f32x4_add(sum0, wasm_f32x4_mul(w0, wasm_v128_load(neighbor)));
            sum1 = wasm_f32x4_add(sum1, wasm_f32x4_mul(w1, wasm_v128_load(neighbor + 4)));
            weight0 = wasm_f32x4_add(weight0, w0);
            weight1 = wasm_f32x4_add(weight1, w1);
            strongest0 = wasm_f32x4_max(strongest0, w0);
            strongest1 = wasm_f32x4_max(strongest1, w1);
        }
        wasm_v128_store(t, sum0);
        wasm_v128_store(t + 4, sum1);
        wasm_v128_store(t + size, weight0);
        wasm_v128_store(t + size + 4, weight1);
        wasm_v128_store(t + 2 * size, strongest0);
        wasm_v128_store(t + 2 * size + 4, strongest1);
    }
}

static inline __attribute__((always_inline)) void tile_offsets(const Means *m, const float *origin, long localWidth, long toCoverage, long y0, long y1,
                                                               float *total, long size, long lanes, float *weights, long count, float *column, long span,
                                                               const int patch, const int opaque) {
    const int search = m->search, window = 2 * patch + 1;
    for (int dy = 0; dy <= search; ++dy) {
        const int first = dy == 0 ? 1 : -search, group = search - first + 1;
        const long shift = dy * localWidth + first;
        memset(column, 0, group * span * sizeof(float));
        for (long y = y0 - dy - patch; y < y0 - dy + patch; ++y) {
            const float *row = origin + (y - y0) * localWidth - search - patch;
            for (int g = 0; g < group; ++g) column_add(column + g * span, row, shift + g, span);
        }
        for (long y = y0 - dy; y < y1; ++y) {
            const float *entering = origin + (y + patch - y0) * localWidth - search - patch, *leaving = entering - window * localWidth;
            for (int g = 0; g < group; ++g) {
                if (y > y0 - dy) column_slide(column + g * span, entering, leaving, shift + g, span);
                else column_add(column + g * span, entering, shift + g, span);
                weight_row(m, weights + g * count, column + g * span, count, window);
            }
            if (y >= y0) gather_row(total + (y - y0) * lanes, size, lanes, weights + search, count, origin + (y + dy - y0) * localWidth + first, toCoverage, group, 1, opaque);
            if (y + dy < y1) gather_row(total + (y + dy - y0) * lanes, size, lanes, weights + search - first, count - 1, origin + (y - y0) * localWidth - first, toCoverage, group, -1, opaque);
        }
    }
}

// One tile of the inside, where every patch lies within the picture. A row of the offsets with the same dy at a time,
// from the half that comes first: their weights go to the row's pixels, and to the pixels they point at.
static void inside_tile(const Means *m, long y0, long y1, long x0, long x1, float *scratch) {
    const int search = m->search, patch = m->patch;
    const long rows = y1 - y0, columns = x1 - x0, top = search + patch, left = 2 * search + patch;
    const long localWidth = columns + 2 * left + 24, localHeight = rows + 2 * top;
    const long lanes = (columns + 7) & ~7, count = (lanes + 2 * search + 7) & ~7, span = (count + 2 * patch + 3) & ~3, size = rows * lanes;
    float *luma = scratch, *coverage = luma + localHeight * localWidth, *total = coverage + localHeight * localWidth;
    float *weights = total + 3 * size, *column = weights + (2 * search + 1) * count;
    int opaque = 1;
    for (long i = 0; i < localHeight; ++i) {
        long y = clamp_index(y0 - top + i, m->height);
        for (long j = 0; j < localWidth; ++j) {
            long source = y * m->width + clamp_index(x0 - left + j, m->width);
            luma[i * localWidth + j] = m->luma[source];
            coverage[i * localWidth + j] = m->coverage[source];
            opaque &= m->coverage[source] == 1;
        }
    }
    memset(total, 0, 3 * size * sizeof(float));
    const float *origin = luma + top * localWidth + left;
    const long toCoverage = coverage - luma;
    if (patch == 1 && opaque) tile_offsets(m, origin, localWidth, toCoverage, y0, y1, total, size, lanes, weights, count, column, span, 1, 1);
    else if (patch == 1) tile_offsets(m, origin, localWidth, toCoverage, y0, y1, total, size, lanes, weights, count, column, span, 1, 0);
    else if (opaque) tile_offsets(m, origin, localWidth, toCoverage, y0, y1, total, size, lanes, weights, count, column, span, 2, 1);
    else tile_offsets(m, origin, localWidth, toCoverage, y0, y1, total, size, lanes, weights, count, column, span, 2, 0);
    finish(m, y0, y1, x0, x1, total, total + size, total + 2 * size, 0, lanes);
}

static void difference_add(float *column, const Means *m, long row, int dy, int dx, long first, long last, float sign) {
    const long width = m->width;
    const float *a = m->luma + row * width, *b = m->luma + clamp_index(row + dy, m->height) * width;
    long low = first > -dx ? first : -dx, high = last < width - dx ? last : width - dx;
    if (low > last) low = last;
    if (high < low) high = low;
    for (long c = first; c < low; ++c) { float d = a[c] - b[0]; column[c] += sign * (d * d); }
    for (long c = low; c < high; ++c) { float d = a[c] - b[c + dx]; column[c] += sign * (d * d); }
    for (long c = high; c < last; ++c) { float d = a[c] - b[width - 1]; column[c] += sign * (d * d); }
}

static size_t frame_floats(long rows, long columns, int patch) { return 3 * rows * columns + columns + 2 * patch; }

// Pixels within a patch of the edge, every offset in turn, with clamped rows and columns as in AdjustPixels.c.
static void frame(const Means *m, long y0, long y1, long x0, long x1, float *scratch) {
    if (y0 >= y1 || x0 >= x1) return;
    const int search = m->search, patch = m->patch;
    const long width = m->width, height = m->height, rows = y1 - y0, columns = x1 - x0, size = rows * columns;
    const long first = x0 - patch < 0 ? 0 : x0 - patch, last = x1 + patch > width ? width : x1 + patch;
    float *total = scratch, *weights = total + size, *strongest = weights + size, *column = strongest + size - (x0 - patch);
    memset(total, 0, 3 * size * sizeof(float));
    for (int dy = -search; dy <= search; ++dy) {
        for (int dx = -search; dx <= search; ++dx) {
            if (dy == 0 && dx == 0) continue;
            memset(column + first, 0, (last - first) * sizeof(float));
            for (int k = -patch; k <= patch; ++k) difference_add(column, m, clamp_index(y0 + k, height), dy, dx, first, last, 1);
            for (long y = y0; y < y1; ++y) {
                if (y > y0) {
                    difference_add(column, m, clamp_index(y + patch, height), dy, dx, first, last, 1);
                    difference_add(column, m, clamp_index(y - 1 - patch, height), dy, dx, first, last, -1);
                }
                for (long c = x0 - patch; c < first; ++c) column[c] = column[first];
                for (long c = last; c < x1 + patch; ++c) column[c] = column[last - 1];
                const long neighborRow = clamp_index(y + dy, height) * width;
                for (long x = x0; x < x1; ++x) {
                    float sum = 0;
                    for (int t = -patch; t <= patch; ++t) sum += column[x + t];
                    float weight = weight_for(m, sum);
                    if (weight == 0) continue;
                    long neighbor = neighborRow + clamp_index(x + dx, width), index = (y - y0) * columns + (x - x0);
                    weight *= m->coverage[neighbor];
                    total[index] += weight * m->luma[neighbor];
                    weights[index] += weight;
                    if (weight > strongest[index]) strongest[index] = weight;
                }
            }
        }
    }
    finish(m, y0, y1, x0, x1, total, weights, strongest, 0, columns);
}

// The left or right edge turned on its side, its columns rows, so that it's worked as the top is.
static void side(const Means *m, int right, float *scratch) {
    const long depth = 2 * m->patch + m->search, length = m->height, plane = depth * length;
    float *luma = scratch + frame_floats(m->patch, length, m->patch), *coverage = luma + plane, *out = coverage + plane;
    for (long y = 0; y < length; ++y) {
        for (long i = 0; i < depth; ++i) {
            long source = y * m->width + (right ? m->width - 1 - i : i);
            luma[i * length + y] = m->luma[source];
            coverage[i * length + y] = m->coverage[source];
        }
    }
    Means turned = *m;
    turned.luma = luma, turned.coverage = coverage, turned.out = out, turned.width = length, turned.height = depth;
    frame(&turned, 0, m->patch, m->patch, length - m->patch, scratch);
    for (long y = m->patch; y < length - m->patch; ++y) {
        for (long i = 0; i < m->patch; ++i) m->out[y * m->width + (right ? m->width - 1 - i : i)] = out[i * length + y];
    }
}

static int nonlocal_means_simd(const float *luma, const float *coverage, float *out, size_t width, size_t height,
                               int search, int patch, double h, double sigma) {
    if (patch < 1 || patch > 2 || search < 1 || width < 2 * (size_t)(search + patch) + 16 || height < 2 * (size_t)(search + patch) + 16) return 0;
    Means m = { luma, coverage, out, (long)width, (long)height, search, patch, (float)(2 * sigma * sigma), (float)(steps / (6.0 * h * h)),
                (float)((2 * patch + 1) * (2 * patch + 1)) };
    const long top = patch, bottom = m.height - patch, left = patch, right = m.width - patch;
    size_t floats = tile_floats(search, patch), edges = frame_floats(patch, m.width, patch);
    size_t sides = frame_floats(patch, m.height, patch) + 3 * (2 * patch + search) * m.height;
    if (edges > floats) floats = edges;
    if (sides > floats) floats = sides;
    float *scratch = malloc(floats * sizeof(float));
    if (!scratch) return 0;
    for (long y = top; y < bottom; y += tileRows) {
        long y1 = y + tileRows < bottom ? y + tileRows : bottom;
        for (long x = left; x < right; x += tileColumns) {
            long x1 = x + tileColumns < right ? x + tileColumns : right;
            inside_tile(&m, y, y1, x, x1, scratch);
        }
    }
    frame(&m, 0, top, 0, m.width, scratch);
    frame(&m, bottom, m.height, 0, m.width, scratch);
    side(&m, 0, scratch);
    side(&m, 1, scratch);
    free(scratch);
    return 1;
}

__attribute__((constructor)) static void install_nonlocal_means(void) {
    for (int i = 0; i < steps; ++i) table[i] = (float)exp(-6.0 * i / steps);
    adjust_nonlocal_means_gpu = nonlocal_means_simd;
}
