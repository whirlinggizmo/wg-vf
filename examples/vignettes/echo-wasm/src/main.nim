import std/json
import ./vignette_shared

proc log(message: string) =
  echo "[vignette (wasm)] ", message

proc bytesToString(data: openArray[Byte]): string =
  result = newString(data.len)
  for i in 0 ..< data.len:
    result[i] = char(data[i])

proc decodeJsonPayload(data: openArray[Byte]): JsonNode =
  let text = bytesToString(data)
  try:
    result = parseJson(text)
  except CatchableError:
    echo "Failed to parse JSON payload: " & text
    return nil



proc onInit(data: openArray[Byte]) =
  log("received init from host: " & $decodeJsonPayload(data));

proc onHandleMessage(data: openArray[Byte]): uint32 =
  log("received message from host: " & $decodeJsonPayload(data));
  if not enqueueOutbox(data):
    return 2'u32
  0'u32

proc onTick(dtUs, frameId: uint32) =
  log("received tick from host: " & "dtUs=" & $dtUs & ", frameId=" & $frameId)

  discard dtUs
  discard frameId

proc onFixedTick(stepUs, stepIndex: uint32) =
  #log("received fixed tick from host: " & "stepUs=" & $stepUs & ", stepIndex=" & $stepIndex)
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
