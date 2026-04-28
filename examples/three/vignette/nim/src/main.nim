import std/json
import std/random
import std/math
import vignettes/vignette


# Initialize random seed
randomize()

# Game state
type
  Entity = object
    id: string
    x, y, z: float32
    entityType: string  # "cube" or "sphere"
    color: uint32

var entities: seq[Entity] = @[]
var playerId: string = ""
var nextEntityId: uint32 = 0
var elapsedUs: float64 = 0.0

proc log(message: string) =
  when defined(js):
    echo "[three-vignette (nim:js)] ", message
  else:
    echo "[three-vignette (nim:wasm)] ", message

proc sendMessage(msg: JsonNode) =
  let jsonStr = $msg
  var bytes = newSeq[byte](jsonStr.len)
  for i in 0 ..< jsonStr.len:
    bytes[i] = byte(jsonStr[i])
  discard enqueueOutbox(bytes)

proc bytesToString(data: openArray[Byte]): string =
  result = newString(data.len)
  for i in 0 ..< data.len:
    result[i] = char(data[i])

proc allocateEntityId(prefix: string): string =
  nextEntityId += 1
  prefix & "-" & $nextEntityId

proc onInit(data: openArray[Byte]) =
  let text = bytesToString(data)
  log("init: " & text)

proc onHandleMessage(data: openArray[Byte]): uint32 =
  let text = bytesToString(data)
  let msg = parseJson(text)
  
  let msgType = msg["type"].getStr()
  
  case msgType:
    of "SpawnPlayer":
      playerId = allocateEntityId("player")
      let player = Entity(
        id: playerId,
        x: 0.0,
        y: 0.0,
        z: 0.0,
        entityType: "cube",
        color: 0x00ff00'u32
      )
      entities.add(player)
      
      sendMessage(%*{
        "type": "EntitySpawned",
        "entity": {
          "id": player.id,
          "x": player.x,
          "y": player.y,
          "z": player.z,
          "type": player.entityType,
          "color": player.color
        }
      })
      
    of "MoveEntity":
      let id = msg["id"].getStr()
      for entity in entities.mitems:
        if entity.id == id:
          entity.x = msg["x"].getFloat().float32
          entity.y = msg["y"].getFloat().float32
          entity.z = msg["z"].getFloat().float32
          
          sendMessage(%*{
            "type": "EntityMoved",
            "entity": {
              "id": entity.id,
              "x": entity.x,
              "y": entity.y,
              "z": entity.z,
              "type": entity.entityType,
              "color": entity.color
            }
          })
          break
          
    of "SpawnRandomEntity":
      let newEntity = Entity(
        id: allocateEntityId("entity"),
        x: (rand(1.0) - 0.5) * 10,
        y: (rand(1.0) - 0.5) * 10,
        z: (rand(1.0) - 0.5) * 10,
        entityType: if rand(1.0) > 0.5: "cube" else: "sphere",
        color: uint32(rand(0xFFFFFF))
      )
      entities.add(newEntity)
      
      sendMessage(%*{
        "type": "EntitySpawned",
        "entity": {
          "id": newEntity.id,
          "x": newEntity.x,
          "y": newEntity.y,
          "z": newEntity.z,
          "type": newEntity.entityType,
          "color": newEntity.color
        }
      })
      
  return 0

proc onTick(dtUs: uint32, frameId: uint32) =
  elapsedUs += float64(dtUs)
  let elapsedSeconds = elapsedUs / 1_000_000.0

  # sin() outputs -1..+1, so y moves from (-1 * yAmplitude) to (+1 * yAmplitude)
  let yAmplitude = 5.0 # -5 to +5
  for i, entity in entities.mpairs:
    if entity.id != playerId:
      entity.y = sin(elapsedSeconds / 2.0 + float64(entity.x) * 0.5) * yAmplitude
  
  # Send state update at 30fps (every 2 frames at 60fps)
  if frameId mod 2 == 0:
    var entityArray: seq[JsonNode] = @[]
    for entity in entities:
      entityArray.add(%*{
        "id": entity.id,
        "x": entity.x,
        "y": entity.y,
        "z": entity.z,
        "type": entity.entityType,
        "color": entity.color
      })
    
    sendMessage(%*{
      "type": "StateUpdate",
      "entities": entityArray
    })

proc onFixedTick(stepUs: uint32, stepIndex: uint32) =
  discard

proc onShutdown() =
  log("shutdown")

registerVignetteHandlers(
  onInit = onInit,
  onMessage = onHandleMessage,
  onTick = onTick,
  onFixedTick = onFixedTick,
  onShutdown = onShutdown,
)
