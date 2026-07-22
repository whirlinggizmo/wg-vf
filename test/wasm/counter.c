/*
 * Reference `counter` vignette in C (T-VIG-COUNTER / PAR). Mirrors
 * src/testing/vignettes.ts CounterVignette exactly: counts per fixedTick,
 * publishes a frame [stepIndex, counter, sumDtUs] (LE u32 x3), and broadcasts
 * [0xC0, stepIndex] every 10 steps. Registration runs from a constructor, so it
 * works for both the emscripten module and the native .so.
 */

#include "wg_vf.h"

static uint32_t g_counter = 0;
static uint32_t g_sum_dt = 0;
static uint32_t g_seq = 0;

static void put_le(uint8_t *b, int off, uint32_t v) {
  b[off] = (uint8_t)(v & 0xFF);
  b[off + 1] = (uint8_t)((v >> 8) & 0xFF);
  b[off + 2] = (uint8_t)((v >> 16) & 0xFF);
  b[off + 3] = (uint8_t)((v >> 24) & 0xFF);
}

static void on_init(uint8_t *data, uint32_t len) {
  (void)data;
  (void)len;
}

static void on_tick(uint32_t dt_us, uint32_t frame_id) {
  (void)frame_id;
  g_sum_dt += dt_us;
}

static void on_fixed_tick(uint32_t step_us, uint32_t step_index) {
  (void)step_us;
  uint8_t body[12];
  g_counter += 1u;
  g_seq += 1u;
  put_le(body, 0, step_index);
  put_le(body, 4, g_counter);
  put_le(body, 8, g_sum_dt);
  wg_vf_publish_frame(g_seq, body, 12);

  if (g_counter % 10u == 0u) {
    uint8_t ev[5];
    ev[0] = 0xC0;
    put_le(ev, 1, step_index);
    wg_vf_broadcast(ev, 5);
  }
}

static uint32_t on_message(uint32_t sender_id, uint8_t *data, uint32_t len) {
  (void)sender_id;
  (void)data;
  (void)len;
  return 0;
}

__attribute__((constructor)) static void wg_vf_counter_register(void) {
  wg_vf_handlers h = {0};
  h.on_init = on_init;
  h.on_tick = on_tick;
  h.on_fixed_tick = on_fixed_tick;
  h.on_message = on_message;
  wg_vf_register(&h);
}
