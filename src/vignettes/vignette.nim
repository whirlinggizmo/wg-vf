const
  OutboxCap* = 64 * 1024
  OutboxHeaderSize = 12
  OutboxRegionSize = OutboxHeaderSize + OutboxCap
  HeadOffset = 0
  TailOffset = 4
  CapOffset = 8

type
  Byte* = uint8
  VignetteInitHandler* = proc(data: openArray[Byte]) {.nimcall.}
  VignetteMessageHandler* = proc(data: openArray[Byte]): uint32 {.nimcall.}
  VignetteTickHandler* = proc(dtUs, frameId: uint32) {.nimcall.}
  VignetteFixedTickHandler* = proc(stepUs, stepIndex: uint32) {.nimcall.}
  VignetteShutdownHandler* = proc() {.nimcall.}

var
  outboxRegion: array[OutboxRegionSize, Byte]
  onInitCb: VignetteInitHandler
  onMessageCb: VignetteMessageHandler
  onTickCb: VignetteTickHandler
  onFixedTickCb: VignetteFixedTickHandler
  onShutdownCb: VignetteShutdownHandler

proc getU32(offset: int): uint32 {.inline.} =
  result =
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
  if tail >= head:
    tail - head
  else:
    cap - (head - tail)

proc ringFree(head, tail, cap: uint32): uint32 {.inline.} =
  cap - ringUsed(head, tail, cap) - 1'u32

proc ringWriteByte(tail: var uint32, b: Byte) {.inline.} =
  let idx = OutboxHeaderSize + int(tail)
  outboxRegion[idx] = b
  tail = (tail + 1'u32) mod uint32(OutboxCap)

proc enqueueOutbox*(payload: openArray[Byte]): bool =
  let cap = uint32(OutboxCap)
  let head = outboxHead()
  var tail = outboxTail()
  let needed = uint32(4 + payload.len)

  if ringFree(head, tail, cap) < needed:
    return false

  let len = uint32(payload.len)
  ringWriteByte(tail, Byte((len shr 0) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 8) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 16) and 0xFF'u32))
  ringWriteByte(tail, Byte((len shr 24) and 0xFF'u32))

  for i in 0 ..< payload.len:
    ringWriteByte(tail, payload[i])

  setOutboxTail(tail)
  result = true

proc emitText*(msg: string) {.inline.} =
  var data = newSeq[Byte](msg.len)
  for i in 0 ..< msg.len:
    data[i] = Byte(ord(msg[i]))
  discard enqueueOutbox(data)

proc registerVignetteHandlers*(
  onInit: VignetteInitHandler,
  onMessage: VignetteMessageHandler,
  onTick: VignetteTickHandler = nil,
  onFixedTick: VignetteFixedTickHandler = nil,
  onShutdown: VignetteShutdownHandler = nil,
) =
  onInitCb = onInit
  onMessageCb = onMessage
  onTickCb = onTick
  onFixedTickCb = onFixedTick
  onShutdownCb = onShutdown
  initOutbox()

when defined(js):
  proc readPayload(inPtr, len: uint32): seq[Byte] =
    discard inPtr
    result = newSeq[Byte](int(len))
else:
  proc readPayload(inPtr, len: uint32): seq[Byte] =
    result = newSeq[Byte](int(len))
    if len == 0'u32:
      return

    let src = cast[ptr UncheckedArray[Byte]](cast[pointer](inPtr))
    for i in 0 ..< int(len):
      result[i] = src[i]

proc vf_init*(inPtr, inLen: uint32): uint32 {.exportc, cdecl, dynlib.} =
  initOutbox()
  let payload = readPayload(inPtr, inLen)
  if onInitCb != nil:
    onInitCb(payload)
  0'u32

proc vf_tick*(dtUs, frameId: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onTickCb != nil:
    onTickCb(dtUs, frameId)
  0'u32

proc vf_fixed_tick*(stepUs, stepIndex: uint32): uint32 {.exportc, cdecl, dynlib.} =
  if onFixedTickCb != nil:
    onFixedTickCb(stepUs, stepIndex)
  0'u32

proc vf_handle_message*(inPtr, inLen: uint32): uint32 {.exportc, cdecl, dynlib.} =
  let payload = readPayload(inPtr, inLen)
  if onMessageCb != nil:
    return onMessageCb(payload)
  0'u32

proc vf_shutdown*(): uint32 {.exportc, cdecl, dynlib.} =
  if onShutdownCb != nil:
    onShutdownCb()
  initOutbox()
  0'u32

proc vf_outbox_offset*(): uint32 {.exportc, cdecl, dynlib.} =
  cast[uint32](cast[uint](addr outboxRegion[0]))

proc vf_outbox_capacity*(): uint32 {.exportc, dynlib.} =
  uint32(OutboxCap)

when not defined(js):
  proc mem_alloc*(size: uint32): uint32 {.exportc, cdecl, dynlib.} =
    cast[uint32](cast[uint](alloc(int(size))))

  proc mem_free*(memPtr: uint32) {.exportc, cdecl, dynlib.} =
    if memPtr != 0'u32:
      dealloc(cast[pointer](cast[uint](memPtr)))

  proc vf_mem_alloc*(size: uint32): uint32 {.exportc, cdecl, dynlib.} =
    mem_alloc(size)

  proc vf_mem_free*(memPtr: uint32) {.exportc, cdecl, dynlib.} =
    mem_free(memPtr)
else:
  proc mem_alloc*(size: uint32): uint32 {.exportc, cdecl.} =
    discard size
    0'u32

  proc mem_free*(memPtr: uint32) {.exportc, cdecl.} =
    discard memPtr

  proc vf_mem_alloc*(size: uint32): uint32 {.exportc, cdecl.} =
    discard size
    0'u32

  proc vf_mem_free*(memPtr: uint32) {.exportc, cdecl.} =
    discard memPtr

  proc vf_init_message*(data: seq[Byte]): uint32 {.exportc, cdecl.} =
    initOutbox()
    if onInitCb != nil:
      onInitCb(data)
    0'u32

  proc vf_handle_message_js*(data: seq[Byte]): uint32 {.exportc, cdecl.} =
    if onMessageCb != nil:
      return onMessageCb(data)
    0'u32

when defined(js):
  {.emit: """
export function createVignette() {
  const outbox = [];

  function asBytes(payload) {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) {
      return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    if (Array.isArray(payload)) return Uint8Array.from(payload);
    return new Uint8Array(0);
  }

  return {
    async init(initPayload) {
      const bytes = asBytes(initPayload);
      const seqBytes = Array.from(bytes);
      if (typeof vf_init_message === 'function') {
        vf_init_message(seqBytes);
      } else if (typeof vf_init === 'function') {
        vf_init(0, bytes.length >>> 0);
      }
    },

    async tick(dtUs, frameId) {
      if (typeof vf_tick === 'function') {
        vf_tick((dtUs >>> 0), (frameId >>> 0));
      }
    },

    async fixedTick(stepUs, stepIndex) {
      if (typeof vf_fixed_tick === 'function') {
        vf_fixed_tick((stepUs >>> 0), (stepIndex >>> 0));
      }
    },

    async handleMessage(payload) {
      const bytes = asBytes(payload);
      outbox.push(bytes.slice());
      const seqBytes = Array.from(bytes);
      if (typeof vf_handle_message_js === 'function') {
        vf_handle_message_js(seqBytes);
      } else if (typeof vf_handle_message === 'function') {
        vf_handle_message(0, bytes.length >>> 0);
      }
    },

    async shutdown() {
      if (typeof vf_shutdown === 'function') {
        vf_shutdown();
      }
      outbox.length = 0;
    },

    outboxHasMessages() {
      return outbox.length > 0;
    },

    outboxPop() {
      const msg = outbox.shift();
      if (!msg) throw new Error('Outbox is empty');
      return msg;
    },
  };
}
""".}
