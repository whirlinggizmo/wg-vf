import ./vignette_shared

proc onInit(data: openArray[Byte]) =
  if data.len > 0:
    discard enqueueOutbox(data)
  else:
    emitText("echo-wasm init")

proc onHandleMessage(data: openArray[Byte]): uint32 =
  if not enqueueOutbox(data):
    return 2'u32
  0'u32

proc onTick(dtUs, frameId: uint32) =
  discard dtUs
  discard frameId

proc onFixedTick(stepUs, stepIndex: uint32) =
  discard stepUs
  discard stepIndex

proc onShutdown() =
  discard

registerVignetteHandlers(
  onInit = onInit,
  onMessage = onHandleMessage,
  onTick = onTick,
  onFixedTick = onFixedTick,
  onShutdown = onShutdown,
)
