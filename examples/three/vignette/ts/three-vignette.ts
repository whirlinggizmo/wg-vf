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
    // Reconstitute the world from storage if we've run before (survives a reload
    // when the host has a durableStore); otherwise seed a fresh one. peerJoined
    // broadcasts the full state, so a restored world renders as the app attaches.
    if (this.restore()) {
      console.log(`[three-vignette] restored ${this.entities.size} entities from storage`);
    } else {
      for (let i = 0; i < 5; i++) this.spawnRandomEntity();
      this.persist();
    }
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
        this.persist();
        break;
      }
      case "MoveEntity": {
        const entity = msg.id === undefined ? undefined : this.entities.get(msg.id);
        if (entity && msg.x !== undefined && msg.y !== undefined && msg.z !== undefined) {
          entity.x = msg.x;
          entity.y = msg.y;
          entity.z = msg.z;
          this.broadcast(encodePayload({ type: "EntityMoved", entity }));
          this.persist();
        }
        break;
      }
      case "SpawnRandomEntity":
        this.spawnRandomEntity();
        this.persist();
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
    this.persist(); // graceful teardown: the host awaits this
  }

  private createEid(): EID {
    return this.nextEntityId++;
  }

  // --- persistence (see the author guide §13) ------------------------------
  // Persist the *authored* world (entity list, player, id counter). Positions'
  // `y` is re-derived on tick, so we don't care that it's a checkpoint snapshot.

  private persist(): void {
    try {
      this.fs.write(
        "world",
        encodePayload({
          entities: Array.from(this.entities.values()),
          playerId: this.playerId,
          nextEntityId: this.nextEntityId,
        }),
      );
      void this.fs.flush(); // durable barrier; host writes to IndexedDB async
    } catch {
      // No storage on this host → run ephemerally (nothing to restore next time).
    }
  }

  private restore(): boolean {
    let saved: Uint8Array | null;
    try {
      saved = this.fs.read("world");
    } catch {
      return false; // storage unavailable
    }
    if (!saved) return false;
    const state = decodePayload(saved) as { entities: Entity[]; playerId: EID | null; nextEntityId: number };
    this.entities.clear();
    for (const e of state.entities) this.entities.set(e.id, e);
    this.playerId = state.playerId;
    this.nextEntityId = state.nextEntityId;
    return this.entities.size > 0;
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
