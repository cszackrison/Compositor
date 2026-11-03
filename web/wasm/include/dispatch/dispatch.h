#ifndef WASM_DISPATCH_SHIM_H
#define WASM_DISPATCH_SHIM_H
#include <stddef.h>
#define DISPATCH_APPLY_AUTO 0
extern void *_NSConcreteStackBlock[32];
static inline void dispatch_apply(size_t count, int queue, void (^block)(size_t)) {
    (void)queue;
    for (size_t i = 0; i < count; i++) block(i);
}
typedef long dispatch_once_t;
static inline void dispatch_once(dispatch_once_t *once, void (^block)(void)) {
    if (*once) return;
    *once = 1;
    block();
}
#endif
