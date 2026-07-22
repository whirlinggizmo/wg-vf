## Reference `echo` vignette compiled to WASM (T-VIG-ECHO / PAR-01). Mirrors
## src/testing/vignettes.ts EchoVignette: unicasts the bytes back to the sender
## and broadcasts a copy prefixed with the sender id (u16 LE).

import "../../src/vignettes/wasm/vignette"

proc onInit(data: openArray[Byte]) =
  discard data

proc onMessage(senderId: uint32, data: openArray[Byte]): uint32 =
  # Unicast the payload back to the sender.
  emit(uint16(senderId and 0xFFFF'u32), data)

  # Broadcast a copy prefixed with the sender id (u16 LE).
  var tagged = newSeq[Byte](2 + data.len)
  tagged[0] = Byte((senderId shr 0) and 0xFF'u32)
  tagged[1] = Byte((senderId shr 8) and 0xFF'u32)
  for i in 0 ..< data.len:
    tagged[2 + i] = data[i]
  broadcast(tagged)
  0'u32

registerVignetteHandlers(onInit, onMessage)
