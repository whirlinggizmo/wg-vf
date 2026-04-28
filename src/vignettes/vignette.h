/*
 * Vignette Framework C API
 * 
 * Standard FFI interface for vignette shared libraries.
 * Compatible with Nim-generated .so files using {.exportc, cdecl, dynlib.}
 * 
 * MAINTENANCE NOTE: If you add/remove/change exported functions in
 * src/vignettes/vignette.nim, you MUST update this header to match.
 * 
 * FUTURE: If we need bindings for Python/Node.js/Zig/etc, consider using
 * Genny (https://github.com/treeform/genny) instead of maintaining
 * language-specific wrappers by hand. Genny generates bindings for multiple
 * languages from Nim code, but it changes the C naming convention
 * (adds library prefix to avoid symbol collisions).
 */

#ifndef VIGNETTE_H
#define VIGNETTE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Initialize the vignette with payload data */
uint32_t vf_init(uint32_t inPtr, uint32_t inLen);

/* Process a tick (frame update) */
uint32_t vf_tick(uint32_t dtUs, uint32_t frameId);

/* Process a fixed timestep tick */
uint32_t vf_fixed_tick(uint32_t stepUs, uint32_t stepIndex);

/* Handle an incoming message */
uint32_t vf_handle_message(uint32_t inPtr, uint32_t inLen);

/* Shutdown the vignette */
uint32_t vf_shutdown(void);

/* Get the memory offset of the outbox ring buffer */
uint32_t vf_outbox_offset(void);

/* Get the capacity of the outbox ring buffer */
uint32_t vf_outbox_capacity(void);

/* Allocate memory (for host use) */
uint32_t vf_mem_alloc(uint32_t size);

/* Free memory (for host use) */
void vf_mem_free(uint32_t memPtr);

#ifdef __cplusplus
}
#endif

#endif /* VIGNETTE_H */
