// Host-owned peer registry (Part I §3.4, Part II §5). The source of identity
// truth: ids are minted here, bound to at most one transport at a time, never
// reused within a session. Routing drops peer-bound bytes with no live target
// (Part I §1.3) — there is no per-peer resend queue.

import { CLIENT_ID_RESERVED } from '../envelope/types.js';
import type { BytePeer } from '../transports/BytePeer.js';

export class PeerIdExhaustedError extends Error {
  constructor() {
    super('peer id space exhausted for this session');
    this.name = 'PeerIdExhaustedError';
  }
}

export class PeerRegistry {
  // Next id to mint. Starts at 1; 0 = none/broadcast, 0xFFFF reserved.
  private nextId = 1;
  private readonly attached = new Map<number, BytePeer>();

  /** Mint a fresh, never-before-used id for this session. */
  mint(): number {
    if (this.nextId >= CLIENT_ID_RESERVED) {
      throw new PeerIdExhaustedError();
    }
    return this.nextId++;
  }

  /** Bind (or rebind, for reconnect) an id to a transport. */
  attach(clientId: number, pipe: BytePeer): void {
    this.attached.set(clientId, pipe);
  }

  /** Remove the transport binding for an id (leave/evict/detach). */
  detach(clientId: number): void {
    this.attached.delete(clientId);
  }

  isAttached(clientId: number): boolean {
    return this.attached.has(clientId);
  }

  get attachedCount(): number {
    return this.attached.size;
  }

  attachedIds(): number[] {
    return [...this.attached.keys()];
  }

  /**
   * Route peer-bound bytes. `targetId = 0` broadcasts to all attached peers;
   * nonzero unicasts to that peer or is silently dropped if it has no live
   * transport (Part I §1.3). Never buffers.
   */
  route(targetId: number, bytes: Uint8Array): void {
    if (targetId === 0) {
      for (const pipe of this.attached.values()) {
        pipe.send(bytes);
      }
      return;
    }
    this.attached.get(targetId)?.send(bytes);
  }
}
