// T-CLOCK (test plan §0): a manually-advanced clock so every conformance test
// is deterministic and timer-free. Time only moves when the test says so.

import type { Clock } from '../hosts/Clock.js';

export class VirtualClock implements Clock {
  private us: number;

  /** Seed the clock (u32 µs). Seed near 2^32 to exercise wrap (ABI-12). */
  constructor(seedUs = 0) {
    this.us = seedUs >>> 0;
  }

  nowUs(): number {
    return this.us;
  }

  /** Advance the clock by `dtUs`, wrapping at 2^32 µs like the real clock. */
  advance(dtUs: number): void {
    if (!Number.isInteger(dtUs) || dtUs < 0) {
      throw new RangeError(`advance dtUs must be a non-negative integer, got ${dtUs}`);
    }
    this.us = (this.us + dtUs) >>> 0;
  }
}
