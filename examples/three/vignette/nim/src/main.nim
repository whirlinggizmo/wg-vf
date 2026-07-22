## Three.js demo vignette authored in Nim via C interop with wg_vf.h / wg_vf.c.
## The framework glue (outbox ring, frame buffer, vf_* exports) is the shipped C
## implementation; this file provides handler callbacks and registers them —
## demonstrating that any C-ABI language can author a vignette.

import std/json
import std/random
import std/math

type Byte = uint8

# --- C interop with the wg-vf glue (wg_vf.h) -------------------------------

type WgVfHandlers {.importc: "wg_vf_handlers", header: "wg_vf.h", bycopy.} = object
  on_init: proc(data: ptr Byte, len: uint32) {.cdecl.}
  on_tick: proc(dtUs, frameId: uint32) {.cdecl.}
  on_fixed_tick: proc(stepUs, stepIndex: uint32) {.cdecl.}
  on_message: proc(senderId: uint32, data: ptr Byte, len: uint32): uint32 {.cdecl.}
  on_peer_joined: proc(clientId: uint32) {.cdecl.}
  on_peer_left: proc(clientId, reason: uint32) {.cdecl.}
  on_shutdown: proc() {.cdecl.}

proc wg_vf_register(h: ptr WgVfHandlers) {.importc, cdecl, header: "wg_vf.h".}
proc wg_vf_broadcast(data: ptr Byte, len: uint32) {.importc, cdecl, header: "wg_vf.h".}

# --- game state ------------------------------------------------------------

type Entity = object
  id: uint32
  x, y, z: float32
  entityType: string
  color: uint32

var entities: seq[Entity] = @[]
var playerId: uint32 = 0
var nextEntityId: uint32 = 0
var elapsedUs: float64 = 0.0

randomize()

proc broadcastJson(msg: JsonNode) =
  let s = $msg
  var bytes = newSeq[Byte](s.len)
  for i in 0 ..< s.len:
    bytes[i] = Byte(s[i])
  if bytes.len > 0:
    wg_vf_broadcast(addr bytes[0], uint32(bytes.len))
  else:
    wg_vf_broadcast(nil, 0)

proc bytesToString(data: ptr Byte, len: uint32): string =
  result = newString(int(len))
  if len == 0'u32:
    return
  let arr = cast[ptr UncheckedArray[Byte]](data)
  for i in 0 ..< int(len):
    result[i] = char(arr[i])

proc entityJson(e: Entity): JsonNode =
  %*{"id": e.id, "x": e.x, "y": e.y, "z": e.z, "type": e.entityType, "color": e.color}

proc allocId(): uint32 =
  nextEntityId += 1
  nextEntityId

proc spawnRandom(): Entity =
  result = Entity(
    id: allocId(),
    x: (rand(1.0) - 0.5) * 10,
    y: (rand(1.0) - 0.5) * 10,
    z: (rand(1.0) - 0.5) * 10,
    entityType: (if rand(1.0) > 0.5: "cube" else: "sphere"),
    color: uint32(rand(0xFFFFFF)),
  )
  entities.add(result)
  broadcastJson(%*{"type": "EntitySpawned", "entity": entityJson(result)})

proc stateUpdate() =
  var arr: seq[JsonNode] = @[]
  for e in entities:
    arr.add(entityJson(e))
  broadcastJson(%*{"type": "StateUpdate", "entities": arr})

# --- handlers --------------------------------------------------------------

proc onInit(data: ptr Byte, len: uint32) {.cdecl.} =
  discard bytesToString(data, len)
  for i in 0 ..< 5:
    discard spawnRandom()

proc onTick(dtUs, frameId: uint32) {.cdecl.} =
  elapsedUs += float64(dtUs)
  let seconds = elapsedUs / 1_000_000.0
  for e in entities.mitems:
    if e.id != playerId:
      e.y = float32(sin(seconds / 2.0 + float64(e.x) * 0.5) * 5.0)
  if frameId mod 2 == 0:
    stateUpdate()

proc onMessage(senderId: uint32, data: ptr Byte, len: uint32): uint32 {.cdecl.} =
  discard senderId
  let msg = parseJson(bytesToString(data, len))
  case msg["type"].getStr()
  of "SpawnPlayer":
    playerId = allocId()
    let player = Entity(id: playerId, x: 0, y: 0, z: 0, entityType: "cube", color: 0x00ff00'u32)
    entities.add(player)
    broadcastJson(%*{"type": "EntitySpawned", "entity": entityJson(player)})
  of "SpawnRandomEntity":
    discard spawnRandom()
  else:
    discard
  0'u32

proc onPeerJoined(clientId: uint32) {.cdecl.} =
  discard clientId
  stateUpdate()

# --- register (runs at module init) ---------------------------------------

var handlers: WgVfHandlers
handlers.on_init = onInit
handlers.on_tick = onTick
handlers.on_message = onMessage
handlers.on_peer_joined = onPeerJoined
wg_vf_register(addr handlers)
