/*
 * wg-vf — Vignette Framework v2 C ABI
 *
 * The single header both the WASM (worker-hosted) and native (server-hosted)
 * bindings compile against: one C/Nim/Rust/Zig source becomes a browser-worker
 * `.wasm` and a service `.so` from the same code. See docs/architecture-part1.md
 * §2.5. This is a mechanical rendering of the canonical ABI (§2.1); it adds no
 * semantics.
 *
 * Lifecycle exports return 0 on success. A nonzero return (or a trap) is fatal
 * to the sim — a trapped instance's memory is not trustworthy (§2.4).
 *
 * Byte order is little-endian throughout, matching the wire envelope.
 */

#ifndef WG_VF_H
#define WG_VF_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* --- Lifecycle (host-driven, serial; §2.2) ------------------------------- */

/* Once, before anything else. Payload staged at (in_ptr, in_len). */
uint32_t vf_init(uint32_t in_ptr, uint32_t in_len);

/* Once per host loop iteration while READY. */
uint32_t vf_tick(uint32_t dt_us, uint32_t frame_id);

/* Zero or more times per iteration; always exactly step_us (§2.3). */
uint32_t vf_fixed_tick(uint32_t step_us, uint32_t step_index);

/* Per inbound App envelope. sender_id is host-stamped (§1.3). */
uint32_t vf_handle_message(uint32_t sender_id, uint32_t in_ptr, uint32_t in_len);

/* After a peer joins, before its first vf_handle_message. */
uint32_t vf_peer_joined(uint32_t client_id);

/* On leave (0), fault eviction (1), or grace-period timeout (2). */
uint32_t vf_peer_left(uint32_t client_id, uint32_t reason);

/* Once, last. No export is invoked after it. */
uint32_t vf_shutdown(void);

/* --- Outbox (drained by the host after every op; §2.1/§2.2) --------------
 *
 * A ring buffer at vf_outbox_offset(), capacity vf_outbox_capacity().
 * Header (12 bytes, LE): [head u32][tail u32][cap u32].
 * Each entry, starting at offset 12: [payload_len u32][target_id u16][payload].
 * target_id 0 = broadcast; nonzero = unicast to that peer (§1.3).
 */
uint32_t vf_outbox_offset(void);
uint32_t vf_outbox_capacity(void);

/* --- Frame channel (latest-wins; §1.4) -----------------------------------
 *
 * The host snapshots vf_frame_len() bytes at vf_frame_offset() after a
 * fixedTick burst and stamps the frame with the sim step. vf_frame_seq() is the
 * vignette-owned monotonic frameSeq. A length of 0 means "no frame yet".
 */
uint32_t vf_frame_offset(void);
uint32_t vf_frame_len(void);
uint32_t vf_frame_seq(void);

/* --- Input staging (host writes payloads here before calls) --------------- */

uint32_t vf_mem_alloc(uint32_t size);
void     vf_mem_free(uint32_t ptr);

#ifdef __cplusplus
}
#endif

#endif /* WG_VF_H */
