// Vignette ABI v2 — the TypeScript binding of the canonical operation set
// (docs/architecture-part1.md §2.1). Parallel to the v1 `Vignette` interface
// until the hosts migrate. Every binding (TS, WASM, C) is a mechanical
// rendering of the same table; this one adds no semantics of its own.
//
// Operations may be sync or async; the host invokes them strictly serially,
// never concurrently or reentrantly (Part I §2.2), awaiting each in turn.

import type { VignetteFs } from '../storage/VignetteStorage.js';

/**
 * Host-provided capabilities handed to a vignette before `init` via
 * {@link Vignette.attachServices}. The host owns the backend, so this works the
 * same for TS, wasm, and native. Extensible — a logger/config/fetch may join
 * `fs` later. `fs` is the jailed vignette filesystem (synchronous ops + an async
 * `flush()` durability barrier you call at your own cadence).
 */
export interface VignetteServices {
  fs: VignetteFs;
}

/** Reason a peer left, delivered to `peerLeft` (Part I §2.1). */
export enum PeerLeftReason {
  Left = 0,
  Fault = 1,
  TimedOut = 2,
}

/**
 * Thrown by a binding to force **sim-fatal** handling even from
 * `handleMessage` (Part I §2.4). A JS vignette throwing an ordinary Error in
 * `handleMessage` is a *peer* fault; a WASM trap is always sim-fatal, since a
 * trapped instance's memory is untrustworthy — the WASM binding surfaces that
 * by throwing this (ABI-18 vs ABI-15).
 */
export class SimFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimFatalError';
  }
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
  /**
   * The wg-vf ABI version this vignette was built against. Set automatically by
   * `BaseVignette`; a hand-rolled `implements Vignette` sets it to
   * `WG_VF_ABI_VERSION` to be loadable in **module form** (dynamic import),
   * where the host checks it and refuses a mismatch. Not required for the
   * in-process factory (`create`) form, which the compiler already checks.
   */
  readonly abiVersion?: number;

  /**
   * Receive host capabilities (storage, …) once, before `init`. Optional — a
   * vignette that needs none can omit it; `BaseVignette` implements it for you.
   */
  attachServices?(services: VignetteServices): void;

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
