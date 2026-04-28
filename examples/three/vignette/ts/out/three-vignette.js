const decoder = new TextDecoder();
const encoder = new TextEncoder();
function encodePayload(data) {
  return encoder.encode(JSON.stringify(data));
}
function decodePayload(bytes) {
  return JSON.parse(decoder.decode(bytes));
}
class ThreeVignette {
  outbox = [];
  entities = [];
  playerId = null;
  elapsedUs = 0;
  async init(payload) {
    console.log("[three-vignette] init:", decodePayload(payload));
  }
  async tick(dtUs, frameId) {
    this.elapsedUs += dtUs;
    const elapsedSeconds = this.elapsedUs / 1e6;
    for (const entity of this.entities) {
      if (entity.id !== this.playerId) {
        entity.y = Math.sin(elapsedSeconds / 2 + entity.x * 0.5) * 0.5;
      }
    }
    if (frameId % 2 === 0) {
      this.outbox.push(
        encodePayload({
          type: "StateUpdate",
          entities: this.entities
        })
      );
    }
  }
  async fixedTick(_stepUs, _stepIndex) {
  }
  async handleMessage(payload) {
    const msg = decodePayload(payload);
    console.log("[three-vignette] received message:", msg);
    switch (msg.type) {
      case "SpawnPlayer": {
        this.playerId = `player-${Date.now()}`;
        const player = {
          id: this.playerId,
          x: 0,
          y: 0,
          z: 0,
          type: "cube",
          color: 65280
        };
        this.entities.push(player);
        this.outbox.push(
          encodePayload({
            type: "EntitySpawned",
            entity: player
          })
        );
        break;
      }
      case "MoveEntity": {
        const entity = this.entities.find((e) => e.id === msg.id);
        if (entity && msg.x !== void 0 && msg.y !== void 0 && msg.z !== void 0) {
          entity.x = msg.x;
          entity.y = msg.y;
          entity.z = msg.z;
          this.outbox.push(
            encodePayload({
              type: "EntityMoved",
              entity
            })
          );
        }
        break;
      }
      case "SpawnRandomEntity": {
        const newEntity = {
          id: `entity-${Date.now()}`,
          x: (Math.random() - 0.5) * 10,
          y: (Math.random() - 0.5) * 10,
          z: (Math.random() - 0.5) * 10,
          type: Math.random() > 0.5 ? "cube" : "sphere",
          color: Math.floor(Math.random() * 16777215)
        };
        this.entities.push(newEntity);
        this.outbox.push(
          encodePayload({
            type: "EntitySpawned",
            entity: newEntity
          })
        );
        break;
      }
    }
  }
  async shutdown() {
    console.log("[three-vignette] shutdown");
  }
  outboxHasMessages() {
    return this.outbox.length > 0;
  }
  outboxPop() {
    const msg = this.outbox.shift();
    if (!msg) {
      throw new Error("Outbox is empty");
    }
    return msg;
  }
}
export {
  ThreeVignette as default
};
//# sourceMappingURL=three-vignette.js.map
