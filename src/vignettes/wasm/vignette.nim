## wg-vf Vignette ABI v2 — Nim framework glue (native + wasm targets).
##
## One source compiles to a worker-hosted `.wasm` (via emscripten) and a
## server-hosted `.so`, both exposing the wg_vf.h C ABI. A vignette author
## implements the handler procs and calls registerVignetteHandlers; the exported
## vf_* functions, the outbox ring buffer, and the frame buffer live here.
##
## Keep in lockstep with wg_vf.h.

const
  OutboxCap* = 64 * 1024
  OutboxHeaderSize = 12
  OutboxRegionSize = OutboxHeaderSize + OutboxCap
  FrameCap* = 64 * 1024

const
  HeadOffset = 0
  TailOffset = 4
  CapOffset = 8

type
  Byte* = uint8
  VignetteInitHandler* = proc(data: openArray[Byte]) {.nimcall.}
  VignetteMessageHandler* = proc(senderId: uint32, data: openArray[Byte]) {.nimcall.}
  VignetteTickHandler* = proc(dtUs, frameId: uint32) {.nimcall.}
  VignetteFixedTickHandler* = proc(stepUs, stepIndex: uint32) {.nimcall.}
  VignettePeerJoinedHandler* = proc(clientId: uint32) {.nimcall.}
  VignettePeerLeftHandler* = proc(clientId, reason: uint32) {.nimcall.}
  VignetteShutdownHandler* = proc() {.nimcall.}

var
  outboxRegion: array[OutboxRegionSize, Byte]
  frameRegion: array[FrameCap, Byte]
  frameLen: uint32 = 0
  frameSeq: uint32 = 0

var
  onInitCb: VignetteInitHandler
  onMessageCb: VignetteMessageHandler
  onTickCb: VignetteTickHandler
  onFixedTickCb: VignetteFixedTickHandler
  onPeerJoinedCb: VignettePeerJoinedHandler
  onPeerLeftCb: VignettePeerLeftHandler
  onShutdownCb: VignetteShutdownHandler

proc getU32(offset: int): uint32 {.inline.} =
  (uint32(outboxRegion[offset + 0]) shl 0) or
  (uint32(outboxRegion[offset + 1]) shl 8) or
  (uint32(outboxRegion[offset + 2]) shl 16) or
  (uint32(outboxRegion[offset + 3]) shl 24)

proc putU32(offset: int, value: uint32) {.inline.} =
  outboxRegion[offset + 0] = Byte((value shr 0) and 0xFF'u32)
  outboxRegion[offset + 1] = Byte((value shr 8) and 0xFF'u32)
  outboxRegion[offset + 2] = Byte((value shr 16) and 0xFF'u32)
  outboxRegion[offset + 3] = Byte((value shr 24) and 0xFF'u32)

proc outboxHead(): uint32 {.inline.} = getU32(HeadOffset)
proc outboxTail(): uint32 {.inline.} = getU32(TailOffset)
proc setOutboxHead(v: uint32) {.inline.} = putU32(HeadOffset, v)
proc setOutboxTail(v: uint32) {.inline.} = putU32(TailOffset, v)

proc initOutbox() {.inline.} =
  setOutboxHead(0'u32)
  setOutboxTail(0'u32)
  putU32(CapOffset, uint32(OutboxCap))

proc ringUsed(head, tail, cap: uint32): uint32 {.inline.} =
  if tail >= head: tail - head else: cap - (head - tail)

proc ringFree(head, tail, cap: uint32): uint32 {.inline.} =
  cap - ringUsed(head, tail, cap) - 1'u32

proc ringWriteByte(tail: var uint32, b: Byte) {.inline.} =
  outboxRegion[OutboxHeaderSize + int(tail)] = b
  tail = (tail + 1'u32) mod uint32(OutboxCap)

## Queue one outbox entry: [payload_len u32][target_id u16][payload].
## target 0 broadcasts; nonzero unicasts to that peer.
proc enqueueOutbox*(target: uint16, payload: openArray[Byte]): bool =
  let cap = uint32(OutboxCap)
  let head = outboxHead()
  var tail = outboxTail()
  let needed = uint32(4 + 2 + payload.len)
  if ringFree(head, tail, cap) < needed:
    return false

  let len = uint32(payload.len)
  ringWriteByte(tail, Byte((len shr 0) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 8) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 16) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 24) and 0xFF'u32))
  ringWriteByte(tail, Byte((target shr 0) and 0xFF'u16))
  ringWriteByte(tail, Byte((target shr 8) and 0xFF'u16))
  for i in 0 ..< payload.len:
    ringWriteByte(tail, payload[i])

  setOutboxTail(tail)
  true

## Unicast to a specific peer.
proc emit*(target: uint16, payload: openArray[Byte]) {.inline.} =
  discard enqueueOutbox(target, payload)

## Broadcast to every attached peer.
proc broadcast*(payload: openArray[Byte]) {.inline.} =
  discard enqueueOutbox(0'u16, payload)

## Replace the current frame (latest-wins). `seq` is the vignette-owned frameSeq.
proc publishFrame*(seq: uint32, body: openArray[Byte]) =
  if uint32(body.len) > uint32(FrameCap):
    return
  for i in 0 ..< body.len:
    frameRegion[i] = body[i]
  frameLen = uint32(body.len)
  frameSeq = seq

proc registerVignetteHandlers*(
  onInit: VignetteInitHandler,
  onMessage: VignetteMessageHandler,
  onTick: VignetteTickHandler = nil,
  onFixedTick: VignetteFixedTickHandler = nil,
  onPeerJoined: VignettePeerJoinedHandler = nil,
  onPeerLeft: VignettePeerLeftHandler = nil,
  onShutdown: VignetteShutdownHandler = nil,
) =
  onInitCb = onInit
  onMessageCb = onMessage
  onTickCb = onTick
  onFixedTickCb = onFixedTick
  onPeerJoinedCb = onPeerJoined
  onPeerLeftCb = onPeerLeft
  onShutdownCb = onShutdown
  initOutbox()

proc readPayload(inPtr, len: uint32): seq[Byte] =
  result = newSeq[Byte](int(len))
  if len == 0'u32:
    return
  let src = cast[ptr UncheckedArray[Byte]](cast[pointer](inPtr))
  for i in 0 ..< int(len):
    result[i] = src[i]

# --- exported ABI (wg_vf.h) -------------------------------------------------

proc vf_init*(inPtr, inLen: uint32): uint32 {.exportc, cdecl, dynlib.} =
  initOutbox()
  let payload = readPayload(inPtr, inLen)
  if onInitCb != nil: onInitCb(payload)
  0'u32

proc vf_tick*(dtUs, frameId: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onTickCb != nil: onTickCb(dtUs, frameId)
  0'u32

proc vf_fixed_tick*(stepUs, stepIndex: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onFixedTickCb != nil: onFixedTickCb(stepUs, stepIndex)
  0'u32

proc vf_handle_message*(senderId, inPtr, inLen: uint32): uint32 {.exportc, cdecl, dynlib.} =
  let payload = readPayload(inPtr, inLen)
  if onMessageCb != nil: onMessageCb(senderId, payload)
  0'u32

proc vf_peer_joined*(clientId: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onPeerJoinedCb != nil: onPeerJoinedCb(clientId)
  0'u32

proc vf_peer_left*(clientId, reason: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onPeerLeftCb != nil: onPeerLeftCb(clientId, reason)
  0'u32

proc vf_shutdown*(): uint32 {.exportc, cdecl, dynlib.} =
  if onShutdownCb != nil: onShutdownCb()
  initOutbox()
  0'u32

proc vf_outbox_offset*(): uint32 {.exportc, cdecl, dynlib.} =
  cast[uint32](cast[uint](addr outboxRegion[0]))

proc vf_outbox_capacity*(): uint32 {.exportc, cdecl, dynlib.} =
  uint32(OutboxCap)

proc vf_frame_offset*(): uint32 {.exportc, cdecl, dynlib.} =
  cast[uint32](cast[uint](addr frameRegion[0]))

proc vf_frame_len*(): uint32 {.exportc, cdecl, dynlib.} =
  frameLen

proc vf_frame_seq*(): uint32 {.exportc, cdecl, dynlib.} =
  frameSeq

proc vf_mem_alloc*(size: uint32): uint32 {.exportc, cdecl, dynlib.} =
  cast[uint32](cast[uint](alloc(int(size))))

proc vf_mem_free*(memPtr: uint32) {.exportc, cdecl, dynlib.} =
  if memPtr != 0'u32:
    dealloc(cast[pointer](cast[uint](memPtr)))
