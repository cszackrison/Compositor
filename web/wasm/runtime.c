#include <stdlib.h>
void *_NSConcreteStackBlock[32];
// `__block` variables never leave the stack: the dispatch shim runs every block before it returns, so none is copied to the heap.
void _Block_object_assign(void *destination, const void *object, const int flags) { *(const void **)destination = object; }
void _Block_object_dispose(const void *object, const int flags) {}
__attribute__((export_name("wasm_alloc"))) void *wasm_alloc(size_t size) { return malloc(size); }
__attribute__((export_name("wasm_free"))) void wasm_free(void *pointer) { free(pointer); }
