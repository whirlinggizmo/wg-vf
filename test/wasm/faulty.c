/*
 * A vignette that fails inside vf_handle_message on command byte 0xFF by
 * returning nonzero. The host must treat this as sim-fatal (ABI-18), in
 * contrast to a JS vignette throw (peer-fault). A genuine trap surfaces the
 * same way at the host.
 */

#include "wg_vf.h"

static void on_init(uint8_t *data, uint32_t len) {
  (void)data;
  (void)len;
}

static uint32_t on_message(uint32_t sender_id, uint8_t *data, uint32_t len) {
  (void)sender_id;
  if (len > 0 && data[0] == 0xFF) {
    return 1; /* nonzero → sim-fatal at the host */
  }
  return 0;
}

__attribute__((constructor)) static void wg_vf_faulty_register(void) {
  wg_vf_handlers h = {0};
  h.on_init = on_init;
  h.on_message = on_message;
  wg_vf_register(&h);
}
