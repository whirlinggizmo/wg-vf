// The injectable time source every reference host reads through (Part II §2).
// All time entering a sim flows through a single Clock.nowUs() read per loop
// iteration, so swapping the clock swaps all observable timing — the basis for
// deterministic, timer-free conformance tests.

export interface Clock {
  /** Current time in microseconds, u32, wrapping at 2^32 µs (Part I §2.3). */
  nowUs(): number;
}

/** Production clock backed by the platform high-resolution timer. */
export class SystemClock implements Clock {
  nowUs(): number {
    if (typeof performance !== 'undefined' && performance.now) {
      return (performance.now() * 1000) >>> 0;
    }
    return (Date.now() * 1000) >>> 0;
  }
}
