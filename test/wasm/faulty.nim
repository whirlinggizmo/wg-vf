## A WASM vignette that fails inside vf_handle_message on command byte 0xFF, by
## returning a nonzero status. The host must treat this as sim-fatal (ABI-18),
## in contrast to a JS vignette throw (peer-fault, ABI-15). The mechanism is a
## controlled nonzero return; a genuine trap surfaces the same way at the host.

import "../../src/vignettes/wasm/vignette"

proc onInit(data: openArray[Byte]) =
  discard data

proc onMessage(senderId: uint32, data: openArray[Byte]): uint32 =
  discard senderId
  if data.len > 0 and data[0] == 0xFF'u8:
    return 1'u32 # nonzero -> sim-fatal at the host
  0'u32

registerVignetteHandlers(onInit, onMessage)
