import type { Vignette } from "../../../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload } from "../../../codecs/json-codec";

export default class EchoVignette implements Vignette {
  private readonly outbox: Uint8Array[] = [];

  async init(payload: Uint8Array): Promise<void> {
    // no-op for example

    // assume it's json?
    console.log("[vignette (js)] init: ", decodePayload(payload));
  }

  async tick(_dtUs: number, _frameId: number): Promise<void> {
    console.log("[vignette (js)] received tick from host: dtUs=" + _dtUs + ", frameId=" + _frameId);

    // no-op for example
  }

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {
    //console.log("[vignette (js)] fixed tick");
    // no-op for example
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
    console.log("[vignette (js)] received message: ", decodePayload(payload));

    // echo it back
    this.outbox.push(payload.slice());
  }

  async shutdown(): Promise<void> {
    this.outbox.length = 0;
  }

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    const msg = this.outbox.shift();
    if (!msg) {
      throw new Error("[vignette] vignette outbox is empty");
    }
    return msg;
  }
}

export function createVignette(): Vignette {
  return new EchoVignette();
}
