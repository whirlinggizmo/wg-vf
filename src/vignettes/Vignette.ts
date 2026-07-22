// Vignette ABI v2 — the TypeScript binding of the canonical operation set
// (docs/architecture-part1.md §2.1). Parallel to the v1 `Vignette` interface
// until the hosts migrate. Every binding (TS, WASM, C) is a mechanical
// rendering of the same table; this one adds no semantics of its own.
//
// Operations may be sync or async; the host invokes them strictly serially,
// never concurrently or reentrantly (Part I §2.2), awaiting each in turn.

/** Reason a peer left, delivered to `peerLeft` (Part I §2.1). */
export enum PeerLeftReason {
  Left = 0,
  Fault = 1,
  TimedOut = 2,
}

/** One outbox entry. `targetId = 0` broadcasts to all attached peers (§1.3). */
export interface OutboxEntry {
  targetId: number;
  payload: Uint8Array;
}

/**
 * The current publishable frame (Part I §1.4). `seq` is the vignette-owned
 * monotonic `frameSeq`; the host stamps `sourceTick` from the step it publishes
 * after. Body is opaque application bytes.
 */
export interface FrameView {
  seq: number;
  body: Uint8Array;
}

export interface Vignette {
  init(initPayload: Uint8Array): void | Promise<void>;
  tick(dtUs: number, frameId: number): void | Promise<void>;
  fixedTick(stepUs: number, stepIndex: number): void | Promise<void>;
  /** `senderId` is host-stamped; peers cannot forge it (Part I §1.3). */
  handleMessage(senderId: number, payload: Uint8Array): void | Promise<void>;
  /** Delivered before this peer's first `handleMessage` (Part I §2.2). */
  peerJoined(clientId: number): void | Promise<void>;
  /** No `handleMessage` for this id is delivered after this (Part I §2.2). */
  peerLeft(clientId: number, reason: PeerLeftReason): void | Promise<void>;
  shutdown(): void | Promise<void>;

  outboxHasMessages(): boolean;
  outboxPop(): OutboxEntry;

  /**
   * The current frame to publish, or null if the vignette has none. The host
   * calls this after a fixedTick burst that ran ≥1 step; a null return, or a
   * burst that ran zero steps, publishes nothing (Part I §1.4 silence rule).
   */
  currentFrame?(): FrameView | null;
}
