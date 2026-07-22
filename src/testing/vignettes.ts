// Reference vignettes for the conformance suite (test plan §0, T-VIG-*).
// Written against the Vignette ABI v2. Kept deterministic (no ambient time,
// fixed iteration orders) so cross-host traces are byte-identical (DET suite).

import { BaseVignette } from '../vignettes/BaseVignette.js';
import { PeerLeftReason, type FrameView } from '../vignettes/Vignette.js';

/**
 * T-VIG-ECHO: every handleMessage(sender, bytes) unicasts the bytes back to the
 * sender and broadcasts a copy prefixed with the sender id (u16 LE).
 */
export class EchoVignette extends BaseVignette {
  override handleMessage(senderId: number, payload: Uint8Array): void {
    this.emit(senderId, payload.slice());
    const tagged = new Uint8Array(2 + payload.length);
    new DataView(tagged.buffer).setUint16(0, senderId, true);
    tagged.set(payload, 2);
    this.broadcast(tagged);
  }
}

/** Frame body layout: stepIndex u32, counter u32, sumDtUs u32 (all LE). */
export const COUNTER_FRAME_SIZE = 12;

/**
 * T-VIG-COUNTER: increments a counter per fixedTick, publishes a frame each
 * fixedTick, broadcasts an event every `emitEvery` steps, and records peer
 * membership calls into readable state.
 */
export class CounterVignette extends BaseVignette {
  private counter = 0;
  private sumDtUs = 0;
  private frameSeq = 0;
  private readonly frameBody = new Uint8Array(COUNTER_FRAME_SIZE);
  private readonly frameView = new DataView(this.frameBody.buffer);
  private readonly emitEvery: number;

  readonly joined: number[] = [];
  readonly left: Array<{ id: number; reason: PeerLeftReason }> = [];

  constructor(emitEvery = 10) {
    super();
    this.emitEvery = emitEvery;
  }

  override tick(dtUs: number, _frameId: number): void {
    this.sumDtUs = (this.sumDtUs + dtUs) >>> 0;
  }

  override fixedTick(_stepUs: number, stepIndex: number): void {
    this.counter = (this.counter + 1) >>> 0;
    this.frameSeq = (this.frameSeq + 1) >>> 0;
    this.frameView.setUint32(0, stepIndex, true);
    this.frameView.setUint32(4, this.counter, true);
    this.frameView.setUint32(8, this.sumDtUs, true);

    if (this.emitEvery > 0 && this.counter % this.emitEvery === 0) {
      const event = new Uint8Array(5);
      event[0] = 0xc0;
      new DataView(event.buffer).setUint32(1, stepIndex, true);
      this.broadcast(event);
    }
  }

  override peerJoined(clientId: number): void {
    this.joined.push(clientId);
  }

  override peerLeft(clientId: number, reason: PeerLeftReason): void {
    this.left.push({ id: clientId, reason });
  }

  override currentFrame(): FrameView {
    // Snapshot by value so a later fixedTick can't mutate a published frame.
    return { seq: this.frameSeq, body: this.frameBody.slice() };
  }

  get value(): number {
    return this.counter;
  }
}

export enum ChaosOp {
  ThrowInHandleMessage = 0,
  ThrowInFixedTick = 1,
  EmitOversized = 2,
  EmitToInvalidTarget = 3,
  BusyLoopUs = 4,
}

/**
 * T-VIG-CHAOS: command bytes trigger targeted misbehavior. Byte 0 is the op;
 * remaining bytes are op-specific.
 */
export class ChaosVignette extends BaseVignette {
  private throwNextFixedTick = false;
  private readonly oversizeBytes: number;

  constructor(oversizeBytes = 2 * 1024 * 1024) {
    super();
    this.oversizeBytes = oversizeBytes;
  }

  override handleMessage(senderId: number, payload: Uint8Array): void {
    const op = payload[0];
    switch (op) {
      case ChaosOp.ThrowInHandleMessage:
        throw new Error('chaos: throw in handleMessage');
      case ChaosOp.ThrowInFixedTick:
        this.throwNextFixedTick = true;
        break;
      case ChaosOp.EmitOversized:
        this.emit(senderId, new Uint8Array(this.oversizeBytes));
        break;
      case ChaosOp.EmitToInvalidTarget:
        this.emit(0xbeef, payload.slice(1));
        break;
      case ChaosOp.BusyLoopUs: {
        const us = payload.length >= 5 ? new DataView(payload.buffer, payload.byteOffset).getUint32(1, true) : 0;
        const endMs = Date.now() + us / 1000;
        while (Date.now() < endMs) {
          /* spin */
        }
        break;
      }
      default:
        break;
    }
  }

  override fixedTick(_stepUs: number, _stepIndex: number): void {
    if (this.throwNextFixedTick) {
      this.throwNextFixedTick = false;
      throw new Error('chaos: throw in fixedTick');
    }
  }
}
