// T-LOSSY (test plan §0): a BytePeer decorator that drops Frame-channel
// envelopes at a configurable rate, leaving System/App untouched. Used to show
// the frame channel is droppable (§1.4) without affecting the sim or the
// reliable streams (DET-04). Deterministic via a seeded PRNG.

import type { BytePeer } from '../transports/BytePeer.js';
import { Channel } from '../envelope/index.js';

export interface LossyOptions {
  /** Fraction of Frame envelopes to drop, 0..1. */
  dropFrame?: number;
  /** PRNG seed for reproducible loss. */
  seed?: number;
}

function makePrng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000; // [0, 1)
  };
}

/**
 * Wrap `inner` so bytes *sent* through it may drop Frame envelopes. Inbound
 * (onBytes) is untouched. Wrap the end the host sends through to model
 * downstream frame loss.
 */
export function lossyPipe(inner: BytePeer, options: LossyOptions = {}): BytePeer {
  const dropFrame = options.dropFrame ?? 0;
  const rand = makePrng(options.seed ?? 1);
  return {
    send(bytes: Uint8Array): void {
      // Envelope byte 1 is the channel (§1.2).
      if (bytes.length > 1 && bytes[1] === Channel.Frame && dropFrame > 0 && rand() < dropFrame) {
        return; // dropped
      }
      inner.send(bytes);
    },
    onBytes: (cb) => inner.onBytes(cb),
  };
}
