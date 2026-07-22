import {
  BaseVignette,
  PeerLeftReason,
  type FrameView,
  type Vignette,
} from "../../../../src";

// A minimal v2 demo vignette exercising both channels: it counts on the fixed
// step and publishes a frame each step (Frame channel), and echoes any App
// message back to its sender (App channel).
export default class SimpleVignette extends BaseVignette {
  private counter = 0;
  private frameSeq = 0;
  private readonly body = new Uint8Array(8); // stepIndex u32, counter u32
  private readonly view = new DataView(this.body.buffer);

  override init(payload: Uint8Array): void {
    console.log(`[vignette] init (${payload.length} init bytes)`);
  }

  override fixedTick(_stepUs: number, stepIndex: number): void {
    this.counter = (this.counter + 1) >>> 0;
    this.frameSeq = (this.frameSeq + 1) >>> 0;
    this.view.setUint32(0, stepIndex, true);
    this.view.setUint32(4, this.counter, true);
  }

  override handleMessage(senderId: number, payload: Uint8Array): void {
    const text = new TextDecoder().decode(payload);
    console.log(`[vignette] message from peer ${senderId}: ${text}`);
    this.emit(senderId, new TextEncoder().encode(`echo: ${text}`));
  }

  override peerJoined(clientId: number): void {
    console.log(`[vignette] peer ${clientId} joined`);
  }

  override peerLeft(clientId: number, reason: PeerLeftReason): void {
    console.log(`[vignette] peer ${clientId} left (reason ${reason})`);
  }

  override currentFrame(): FrameView {
    return { seq: this.frameSeq, body: this.body.slice() };
  }
}

export function createVignette(): Vignette {
  return new SimpleVignette();
}
