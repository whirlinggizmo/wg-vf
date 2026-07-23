// Optional convenience base for TS vignettes (Vignette ABI v2). Handles the
// targeted outbox queue so subclasses just call `emit`/`broadcast`. Lifecycle
// ops default to no-ops; override what you need. The host never requires this
// base — any object satisfying Vignette works.

import type { VignetteFs } from '../storage/VignetteStorage.js';
import { WG_VF_ABI_VERSION } from './abi.js';
import {
  PeerLeftReason,
  type FrameView,
  type OutboxEntry,
  type Vignette,
  type VignetteServices,
} from './Vignette.js';

export abstract class BaseVignette implements Vignette {
  /** ABI this build targets; the host checks it when loading in module form. */
  readonly abiVersion = WG_VF_ABI_VERSION;

  private readonly outbox: OutboxEntry[] = [];
  private services?: VignetteServices;

  /** Host injects capabilities before `init` (Vignette.attachServices). */
  attachServices(services: VignetteServices): void {
    this.services = services;
  }

  /**
   * The session's jailed filesystem ({@link VignetteFs}) — synchronous read/
   * write/delete/exists/mkdir/list plus an async `flush()` durability barrier.
   * Throws if the host provided no services (storage is a host capability).
   */
  protected get fs(): VignetteFs {
    if (!this.services) {
      throw new Error('vignette filesystem is not available: this host provided no services');
    }
    return this.services.fs;
  }

  init(_initPayload: Uint8Array): void | Promise<void> {}
  tick(_dtUs: number, _frameId: number): void | Promise<void> {}
  fixedTick(_stepUs: number, _stepIndex: number): void | Promise<void> {}
  handleMessage(_senderId: number, _payload: Uint8Array): void | Promise<void> {}
  peerJoined(_clientId: number): void | Promise<void> {}
  peerLeft(_clientId: number, _reason: PeerLeftReason): void | Promise<void> {}
  shutdown(): void | Promise<void> {}

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): OutboxEntry {
    const entry = this.outbox.shift();
    if (!entry) {
      throw new Error('outboxPop called with empty outbox');
    }
    return entry;
  }

  /** Queue a unicast to `targetId` (nonzero) or a broadcast (`targetId = 0`). */
  protected emit(targetId: number, payload: Uint8Array): void {
    this.outbox.push({ targetId: targetId >>> 0, payload });
  }

  /** Queue a broadcast to every attached peer. */
  protected broadcast(payload: Uint8Array): void {
    this.emit(0, payload);
  }

  // Subclasses that publish frames override this; default: no frame.
  currentFrame?(): FrameView | null;
}
