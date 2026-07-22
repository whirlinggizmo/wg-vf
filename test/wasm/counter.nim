## Reference `counter` vignette compiled to WASM for binding-parity tests
## (test plan T-VIG-COUNTER / PAR). Mirrors src/testing/vignettes.ts
## CounterVignette exactly: counts per fixedTick, publishes a frame
## [stepIndex, counter, sumDtUs] (LE u32 x3), and broadcasts [0xC0, stepIndex]
## every 10 steps.

import "../../src/vignettes/wasm/vignette"

var
  counter: uint32 = 0
  sumDtUs: uint32 = 0
  seqNo: uint32 = 0

proc putLE(buf: var openArray[Byte], off: int, v: uint32) =
  buf[off + 0] = Byte((v shr 0) and 0xFF'u32)
  buf[off + 1] = Byte((v shr 8) and 0xFF'u32)
  buf[off + 2] = Byte((v shr 16) and 0xFF'u32)
  buf[off + 3] = Byte((v shr 24) and 0xFF'u32)

proc onInit(data: openArray[Byte]) =
  discard data

proc onMessage(senderId: uint32, data: openArray[Byte]): uint32 =
  discard senderId
  discard data
  0'u32

proc onTick(dtUs, frameId: uint32) =
  discard frameId
  sumDtUs = sumDtUs + dtUs

proc onFixedTick(stepUs, stepIndex: uint32) =
  discard stepUs
  counter = counter + 1'u32
  seqNo = seqNo + 1'u32

  var body: array[12, Byte]
  putLE(body, 0, stepIndex)
  putLE(body, 4, counter)
  putLE(body, 8, sumDtUs)
  publishFrame(seqNo, body)

  if counter mod 10'u32 == 0'u32:
    var ev: array[5, Byte]
    ev[0] = 0xC0'u8
    putLE(ev, 1, stepIndex)
    broadcast(ev)

proc onPeerJoined(clientId: uint32) =
  discard clientId

proc onPeerLeft(clientId, reason: uint32) =
  discard clientId
  discard reason

registerVignetteHandlers(onInit, onMessage, onTick, onFixedTick, onPeerJoined, onPeerLeft)
