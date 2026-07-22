/*
 * Reference `echo` vignette in C (T-VIG-ECHO / PAR-01). Mirrors
 * src/testing/vignettes.ts EchoVignette: unicasts the bytes back to the sender,
 * then broadcasts a copy prefixed with the sender id (u16 LE).
 */

#include "wg_vf.h"

#include <stdlib.h>
#include <string.h>

static void on_init(uint8_t *data, uint32_t len) {
  (void)data;
  (void)len;
}

static uint32_t on_message(uint32_t sender_id, uint8_t *data, uint32_t len) {
  wg_vf_emit((uint16_t)(sender_id & 0xFFFF), data, len);

  uint8_t *tagged = (uint8_t *)malloc(len + 2u);
  if (!tagged) {
    return 1; /* allocation failure → sim-fatal */
  }
  tagged[0] = (uint8_t)(sender_id & 0xFF);
  tagged[1] = (uint8_t)((sender_id >> 8) & 0xFF);
  if (len) {
    memcpy(tagged + 2, data, len);
  }
  wg_vf_broadcast(tagged, len + 2u);
  free(tagged);
  return 0;
}

__attribute__((constructor)) static void wg_vf_echo_register(void) {
  wg_vf_handlers h = {0};
  h.on_init = on_init;
  h.on_message = on_message;
  wg_vf_register(&h);
}
