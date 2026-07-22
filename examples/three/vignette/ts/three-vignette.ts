import { BaseVignette, PeerLeftReason } from "../../../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload, encodePayload } from "../../../codecs/json-codec";

type EID = number;

interface Entity {
  id: EID;
  x: number;
  y: number;
  z: number;
  type: "cube" | "sphere";
  color: number;
}

// A v2 vignette: owns entity state, animates it on tick, and broadcasts JSON
// state to peers on the App channel. App messages (SpawnPlayer, MoveEntity,
// SpawnRandomEntity) come in via handleMessage(senderId, payload).
export default class ThreeVignette extends BaseVignette {
  private readonly entities = new Map<EID, Entity>();
  private playerId: EID | null = null;
  private elapsedUs = 0;
  private nextEntityId = 1;

  override init(payload: Uint8Array): void {
    console.log("[three-vignette] init:", decodePayload(payload));
    for (let i = 0; i < 5; i++) this.spawnRandomEntity();
  }

  override tick(dtUs: number, frameId: number): void {
    this.elapsedUs += dtUs;
    const elapsedSeconds = this.elapsedUs / 1_000_000;
    const yAmplitude = 5.0;

    for (const entity of this.entities.values()) {
      if (entity.id !== this.playerId) {
        entity.y = Math.sin(elapsedSeconds / 2 + entity.x * 0.5) * yAmplitude;
      }
    }

    // Broadcast a full state update at ~30fps.
    if (frameId % 2 === 0) {
      this.broadcast(
        encodePayload({ type: "StateUpdate", entities: Array.from(this.entities.values()) }),
      );
    }
  }

  override handleMessage(_senderId: number, payload: Uint8Array): void {
    const msg = decodePayload(payload) as {
      type: string;
      id?: number;
      x?: number;
      y?: number;
      z?: number;
    };

    switch (msg.type) {
      case "SpawnPlayer": {
        this.playerId = this.createEid();
        const player: Entity = { id: this.playerId, x: 0, y: 0, z: 0, type: "cube", color: 0x00ff00 };
        this.entities.set(player.id, player);
        this.broadcast(encodePayload({ type: "EntitySpawned", entity: player }));
        break;
      }
      case "MoveEntity": {
        const entity = msg.id === undefined ? undefined : this.entities.get(msg.id);
        if (entity && msg.x !== undefined && msg.y !== undefined && msg.z !== undefined) {
          entity.x = msg.x;
          entity.y = msg.y;
          entity.z = msg.z;
          this.broadcast(encodePayload({ type: "EntityMoved", entity }));
        }
        break;
      }
      case "SpawnRandomEntity":
        this.spawnRandomEntity();
        break;
    }
  }

  override peerJoined(clientId: number): void {
    console.log("[three-vignette] peer joined:", clientId);
    // Bring a new peer up to date immediately.
    this.broadcast(encodePayload({ type: "StateUpdate", entities: Array.from(this.entities.values()) }));
  }

  override peerLeft(clientId: number, reason: PeerLeftReason): void {
    console.log("[three-vignette] peer left:", clientId, reason);
  }

  override shutdown(): void {
    console.log("[three-vignette] shutdown");
  }

  private createEid(): EID {
    return this.nextEntityId++;
  }

  private spawnRandomEntity(): Entity {
    const entity: Entity = {
      id: this.createEid(),
      x: (Math.random() - 0.5) * 10,
      y: (Math.random() - 0.5) * 10,
      z: (Math.random() - 0.5) * 10,
      type: Math.random() > 0.5 ? "cube" : "sphere",
      color: Math.floor(Math.random() * 0xffffff),
    };
    this.entities.set(entity.id, entity);
    this.broadcast(encodePayload({ type: "EntitySpawned", entity }));
    return entity;
  }
}
