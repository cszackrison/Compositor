#include <stdlib.h>
void *_NSConcreteStackBlock[32];
__attribute__((export_name("wasm_alloc"))) void *wasm_alloc(size_t size) { return malloc(size); }
__attribute__((export_name("wasm_free"))) void wasm_free(void *pointer) { free(pointer); }
