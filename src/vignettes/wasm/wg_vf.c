/*
 * wg-vf — Vignette Framework C ABI implementation.
 *
 * Owns the outbox ring buffer, the frame buffer, and the vf_* exports the host
 * drives; dispatches to the author's registered handlers. Compile this together
 * with your vignette translation unit. See wg_vf.h.
 */

#include "wg_vf.h"

#include <stdlib.h>

#define WG_VF_OUTBOX_CAP 65536u
#define WG_VF_OUTBOX_HEADER 12u /* [head u32][tail u32][cap u32] */
#define WG_VF_FRAME_CAP 65536u

#define WG_VF_OFF_HEAD 0u
#define WG_VF_OFF_TAIL 4u
#define WG_VF_OFF_CAP 8u

static uint8_t g_outbox[WG_VF_OUTBOX_HEADER + WG_VF_OUTBOX_CAP];
static uint8_t g_frame[WG_VF_FRAME_CAP];
static uint32_t g_frame_len = 0;
static uint32_t g_frame_seq = 0;
static wg_vf_handlers g_handlers;

/* --- outbox header (LE) --- */

static uint32_t obx_get(uint32_t off) {
  return (uint32_t)g_outbox[off] | ((uint32_t)g_outbox[off + 1] << 8) |
         ((uint32_t)g_outbox[off + 2] << 16) | ((uint32_t)g_outbox[off + 3] << 24);
}

static void obx_put(uint32_t off, uint32_t v) {
  g_outbox[off] = (uint8_t)(v & 0xFF);
  g_outbox[off + 1] = (uint8_t)((v >> 8) & 0xFF);
  g_outbox[off + 2] = (uint8_t)((v >> 16) & 0xFF);
  g_outbox[off + 3] = (uint8_t)((v >> 24) & 0xFF);
}

static void outbox_init(void) {
  obx_put(WG_VF_OFF_HEAD, 0);
  obx_put(WG_VF_OFF_TAIL, 0);
  obx_put(WG_VF_OFF_CAP, WG_VF_OUTBOX_CAP);
}

/* --- ring --- */

static uint32_t ring_used(uint32_t head, uint32_t tail, uint32_t cap) {
  return tail >= head ? tail - head : cap - (head - tail);
}

static uint32_t ring_free(uint32_t head, uint32_t tail, uint32_t cap) {
  return cap - ring_used(head, tail, cap) - 1u;
}

static void ring_write_byte(uint32_t *tail, uint8_t b) {
  g_outbox[WG_VF_OUTBOX_HEADER + *tail] = b;
  *tail = (*tail + 1u) % WG_VF_OUTBOX_CAP;
}

/* Entry: [payload_len u32][target_id u16][payload]. */
static void enqueue(uint16_t target, const uint8_t *data, uint32_t len) {
  uint32_t head = obx_get(WG_VF_OFF_HEAD);
  uint32_t tail = obx_get(WG_VF_OFF_TAIL);
  uint32_t i;
  if (ring_free(head, tail, WG_VF_OUTBOX_CAP) < 6u + len) {
    return; /* full: drop (bounded outbox) */
  }
  ring_write_byte(&tail, (uint8_t)(len & 0xFF));
  ring_write_byte(&tail, (uint8_t)((len >> 8) & 0xFF));
  ring_write_byte(&tail, (uint8_t)((len >> 16) & 0xFF));
  ring_write_byte(&tail, (uint8_t)((len >> 24) & 0xFF));
  ring_write_byte(&tail, (uint8_t)(target & 0xFF));
  ring_write_byte(&tail, (uint8_t)((target >> 8) & 0xFF));
  for (i = 0; i < len; i++) {
    ring_write_byte(&tail, data[i]);
  }
  obx_put(WG_VF_OFF_TAIL, tail);
}

/* --- author API --- */

void wg_vf_register(const wg_vf_handlers *handlers) {
  g_handlers = *handlers;
  outbox_init();
}

void wg_vf_emit(uint16_t target_id, const uint8_t *data, uint32_t len) {
  enqueue(target_id, data, len);
}

void wg_vf_broadcast(const uint8_t *data, uint32_t len) {
  enqueue(0, data, len);
}

void wg_vf_publish_frame(uint32_t seq, const uint8_t *body, uint32_t len) {
  uint32_t i;
  if (len > WG_VF_FRAME_CAP) {
    return;
  }
  for (i = 0; i < len; i++) {
    g_frame[i] = body[i];
  }
  g_frame_len = len;
  g_frame_seq = seq;
}

/* --- host-facing ABI --- */

uint32_t vf_abi_version(void) {
  return WG_VF_ABI_VERSION;
}

uint32_t vf_init(uintptr_t in_ptr, uint32_t in_len) {
  outbox_init();
  if (g_handlers.on_init) {
    g_handlers.on_init((uint8_t *)in_ptr, in_len);
  }
  return 0;
}

uint32_t vf_tick(uint32_t dt_us, uint32_t frame_id) {
  if (g_handlers.on_tick) {
    g_handlers.on_tick(dt_us, frame_id);
  }
  return 0;
}

uint32_t vf_fixed_tick(uint32_t step_us, uint32_t step_index) {
  if (g_handlers.on_fixed_tick) {
    g_handlers.on_fixed_tick(step_us, step_index);
  }
  return 0;
}

uint32_t vf_handle_message(uint32_t sender_id, uintptr_t in_ptr, uint32_t in_len) {
  if (g_handlers.on_message) {
    return g_handlers.on_message(sender_id, (uint8_t *)in_ptr, in_len);
  }
  return 0;
}

uint32_t vf_peer_joined(uint32_t client_id) {
  if (g_handlers.on_peer_joined) {
    g_handlers.on_peer_joined(client_id);
  }
  return 0;
}

uint32_t vf_peer_left(uint32_t client_id, uint32_t reason) {
  if (g_handlers.on_peer_left) {
    g_handlers.on_peer_left(client_id, reason);
  }
  return 0;
}

uint32_t vf_shutdown(void) {
  if (g_handlers.on_shutdown) {
    g_handlers.on_shutdown();
  }
  outbox_init();
  return 0;
}

uintptr_t vf_outbox_offset(void) {
  return (uintptr_t)&g_outbox[0];
}

uint32_t vf_outbox_capacity(void) {
  return WG_VF_OUTBOX_CAP;
}

uintptr_t vf_frame_offset(void) {
  return (uintptr_t)&g_frame[0];
}

uint32_t vf_frame_len(void) {
  return g_frame_len;
}

uint32_t vf_frame_seq(void) {
  return g_frame_seq;
}

uintptr_t vf_mem_alloc(uint32_t size) {
  return (uintptr_t)malloc(size);
}

void vf_mem_free(uintptr_t ptr) {
  if (ptr) {
    free((void *)ptr);
  }
}
