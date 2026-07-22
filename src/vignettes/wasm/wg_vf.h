/*
 * wg-vf — Vignette Framework C ABI (v2)
 *
 * The portable native/wasm binding. One C source (this + wg_vf.c) compiles to a
 * browser-worker `.wasm` and a service `.so`, giving any C-ABI language
 * (C, Rust, Zig, Nim via interop, ...) a working vignette runtime — not just
 * declarations. See docs/architecture-part1.md §2 and the author guide.
 *
 * You (the vignette author):
 *   - implement the handler callbacks in `wg_vf_handlers`,
 *   - register them with wg_vf_register() (e.g. from a constructor),
 *   - emit App output with wg_vf_emit / wg_vf_broadcast,
 *   - publish frame state with wg_vf_publish_frame.
 * The framework (wg_vf.c) owns the outbox ring buffer, the frame buffer, and the
 * vf_* exports the host calls. You never call the vf_* functions yourself.
 *
 * Byte order is little-endian throughout. Pointers/offsets are uintptr_t —
 * 32-bit on wasm32, 64-bit native — so the same code is correct on both.
 */

#ifndef WG_VF_H
#define WG_VF_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ======================================================================== */
/* Author API — implement handlers, register, emit, publish frames.         */
/* ======================================================================== */

/*
 * Handler callbacks. Any may be NULL. `on_message` returns 0 on success; a
 * nonzero return is sim-fatal at the host (§2.4). All calls are serial and
 * single-threaded; `sender_id` is host-stamped and trustworthy (§1.3).
 */
typedef struct {
  /* data params are non-const so the callback pointer types match exactly
   * across C and other-language interop (e.g. Nim). Treat data as read-only. */
  void (*on_init)(uint8_t *data, uint32_t len);
  void (*on_tick)(uint32_t dt_us, uint32_t frame_id);
  void (*on_fixed_tick)(uint32_t step_us, uint32_t step_index);
  uint32_t (*on_message)(uint32_t sender_id, uint8_t *data, uint32_t len);
  void (*on_peer_joined)(uint32_t client_id);
  void (*on_peer_left)(uint32_t client_id, uint32_t reason);
  void (*on_shutdown)(void);
} wg_vf_handlers;

/* Install the handler set (copied by value) and reset the outbox. */
void wg_vf_register(const wg_vf_handlers *handlers);

/* Queue one App message. target_id 0 = broadcast; nonzero = unicast (§1.3). */
void wg_vf_emit(uint16_t target_id, const uint8_t *data, uint32_t len);
void wg_vf_broadcast(const uint8_t *data, uint32_t len);

/* Replace the current frame (latest-wins, §1.4). `seq` is your monotonic frameSeq. */
void wg_vf_publish_frame(uint32_t seq, const uint8_t *body, uint32_t len);

/* ======================================================================== */
/* Host-facing ABI (implemented in wg_vf.c). You do NOT call these.          */
/* Lifecycle exports return 0 on success; nonzero or a trap is sim-fatal.    */
/* ======================================================================== */

uint32_t vf_init(uintptr_t in_ptr, uint32_t in_len);
uint32_t vf_tick(uint32_t dt_us, uint32_t frame_id);
uint32_t vf_fixed_tick(uint32_t step_us, uint32_t step_index);
uint32_t vf_handle_message(uint32_t sender_id, uintptr_t in_ptr, uint32_t in_len);
uint32_t vf_peer_joined(uint32_t client_id);
uint32_t vf_peer_left(uint32_t client_id, uint32_t reason);
uint32_t vf_shutdown(void);

/*
 * Outbox ring buffer at vf_outbox_offset(), capacity vf_outbox_capacity().
 * Header (12 bytes, LE): [head u32][tail u32][cap u32].
 * Each entry from offset 12: [payload_len u32][target_id u16][payload].
 */
uintptr_t vf_outbox_offset(void);
uint32_t vf_outbox_capacity(void);

/* Frame buffer (latest-wins, §1.4). Length 0 means "no frame yet". */
uintptr_t vf_frame_offset(void);
uint32_t vf_frame_len(void);
uint32_t vf_frame_seq(void);

/* Input staging: the host writes payloads here before init/handle_message. */
uintptr_t vf_mem_alloc(uint32_t size);
void vf_mem_free(uintptr_t ptr);

#ifdef __cplusplus
}
#endif

#endif /* WG_VF_H */
