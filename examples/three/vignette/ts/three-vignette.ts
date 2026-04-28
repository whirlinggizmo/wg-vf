import type { Vignette } from "../../../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload, encodePayload } from "../../../codecs/json-codec";

// Game state
interface Entity {
  id: string;
  x: number;
  y: number;
  z: number;
  type: "cube" | "sphere";
  color: number; 
}

export default class ThreeVignette implements Vignette {
  private readonly outbox: Uint8Array[] = [];
  private entities: Entity[] = [];
  private playerId: string | null = null;
  private elapsedUs = 0;

  async init(payload: Uint8Array): Promise<void> {
    console.log("[three-vignette] init:", decodePayload(payload));
  }

  async tick(dtUs: number, frameId: number): Promise<void> {
    this.elapsedUs += dtUs;
    const elapsedSeconds = this.elapsedUs / 1_000_000;
    // sin() outputs -1..+1, so y moves from (-1 * yAmplitude) to (+1 * yAmplitude)
    const yAmplitude = 5.0 // -5 to +5

    // Update entity positions (gentle floating animation)
    for (const entity of this.entities) {
      if (entity.id !== this.playerId) {
        entity.y = Math.sin(elapsedSeconds / 2 + entity.x * 0.5) * yAmplitude;
      }
    }

    // Send state update at 30fps (every 2 frames at 60fps)
    if (frameId % 2 === 0) {
      this.outbox.push(
        encodePayload({
          type: "StateUpdate",
          entities: this.entities,
        }),
      );
    }
  }

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {
    // no-op for this example
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
    const msg = decodePayload(payload) as { type: string; id?: string; x?: number; y?: number; z?: number };
    console.log("[three-vignette] received message:", msg);

    switch (msg.type) {
      case "SpawnPlayer": {
        this.playerId = `player-${Date.now()}`;
        const player: Entity = {
          id: this.playerId,
          x: 0,
          y: 0,
          z: 0,
          type: "cube",
          color: 0x00ff00,
        };
        this.entities.push(player);

        // Send spawn event back to host
        this.outbox.push(
          encodePayload({
            type: "EntitySpawned",
            entity: player,
          }),
        );
        break;
      }

      case "MoveEntity": {
        const entity = this.entities.find((e) => e.id === msg.id);
        if (entity && msg.x !== undefined && msg.y !== undefined && msg.z !== undefined) {
          entity.x = msg.x;
          entity.y = msg.y;
          entity.z = msg.z;

          this.outbox.push(
            encodePayload({
              type: "EntityMoved",
              entity,
            }),
          );
        }
        break;
      }

      case "SpawnRandomEntity": {
        const newEntity: Entity = {
          id: `entity-${Date.now()}`,
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10,
          z: (Math.random() - 0.5) * 10,
          type: Math.random() > 0.5 ? "cube" : "sphere",
          color: Math.floor(Math.random() * 0xffffff),
        };
        this.entities.push(newEntity);

        this.outbox.push(
          encodePayload({
            type: "EntitySpawned",
            entity: newEntity,
          }),
        );
        break;
      }
    }
  }

  async shutdown(): Promise<void> {
    console.log("[three-vignette] shutdown");
  }

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    const msg = this.outbox.shift();
    if (!msg) {
      throw new Error("Outbox is empty");
    }
    return msg;
  }
}
