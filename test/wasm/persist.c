/*
 * Reference `persist` vignette in C — exercises the Vignette FS ABI (wg_vf_fs_*)
 * and mirrors the TS PersistCounter (test/unit/VignetteHostStorage.test.ts): a
 * counter restored from storage on init, bumped + persisted on each message, and
 * echoed back to the sender (u32 LE). Proves wasm ↔ TS storage parity.
 */

#include "wg_vf.h"

static uint32_t g_count = 0;

static uint32_t rd_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void wr_u32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static void on_init(uint8_t *data, uint32_t len) {
  (void)data;
  (void)len;
  uint8_t buf[4];
  int32_t n = wg_vf_fs_read("count", 5u, buf, sizeof(buf)); /* restored before init */
  g_count = (n == 4) ? rd_u32(buf) : 0u;
}

static uint32_t on_message(uint32_t sender_id, uint8_t *data, uint32_t len) {
  (void)data;
  (void)len;
  g_count++;
  uint8_t buf[4];
  wr_u32(buf, g_count);
  wg_vf_fs_write("count", 5u, buf, 4u); /* persist to the mount */
  wg_vf_fs_flush();                     /* durability barrier (host does it async) */
  wg_vf_emit((uint16_t)(sender_id & 0xFFFF), buf, 4u);
  return 0;
}

__attribute__((constructor)) static void wg_vf_persist_register(void) {
  wg_vf_handlers h = {0};
  h.on_init = on_init;
  h.on_message = on_message;
  wg_vf_register(&h);
}
