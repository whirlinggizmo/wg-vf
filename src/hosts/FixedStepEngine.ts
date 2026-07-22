// The determinism core (Part I §2.3, Part II §3). Clock-free and side-effect
// free: it plans how many fixed steps a loop iteration owes, the caller invokes
// the vignette. Because it is the same code under every host, cross-host
// determinism (test plan §4) reduces to "every host drives this identically."
//
// Two behaviors are contract and BOTH differ from the pre-v2 reference host:
//   1. Overload → drop-time: after maxSubsteps, the accumulator is clamped
//      below one step; whole-step debt is discarded, never carried forward.
//      (The pre-v2 host retained the debt.)
//   2. Exactness/monotonicity: every step is exactly stepUs; stepIndex
//      increments by exactly 1 per step, mod 2^32, with no gaps or repeats.

export class FixedStepEngine {
  readonly stepUs: number;
  readonly maxSubsteps: number;

  // Accumulator stays small: it is drained to < stepUs every iteration (either
  // naturally or by the drop-time clamp), so a plain number never overflows.
  private accUs = 0;
  private step = 0;

  /**
   * @param startStepIndex Seed for the step counter (u32). Defaults to 0. A
   *   host normally never sets this; it exists for state reconstruction and to
   *   make the u32 wrap boundary reachable in tests without 2^32 iterations.
   */
  constructor(stepUs: number, maxSubsteps: number, startStepIndex = 0) {
    if (!Number.isInteger(stepUs) || stepUs <= 0) {
      throw new RangeError(`stepUs must be a positive integer, got ${stepUs}`);
    }
    if (!Number.isInteger(maxSubsteps) || maxSubsteps < 0) {
      throw new RangeError(`maxSubsteps must be a non-negative integer, got ${maxSubsteps}`);
    }
    this.stepUs = stepUs;
    this.maxSubsteps = maxSubsteps;
    this.step = startStepIndex >>> 0;
  }

  /** stepIndex the NEXT step will carry (u32). Advances only via consume(). */
  get stepIndex(): number {
    return this.step;
  }

  /** Accumulated microseconds not yet spent on a step. Always < stepUs between iterations. */
  get pendingUs(): number {
    return this.accUs;
  }

  /**
   * Add one iteration's elapsed `dtUs` (a u32 delta) and report how many
   * fixedTicks to run this iteration — never more than `maxSubsteps`. Applies
   * the drop-time clamp so debt never carries. Call consume() exactly that
   * many times, once per fixedTick, to advance stepIndex.
   */
  plan(dtUs: number): number {
    this.accUs += dtUs >>> 0;

    let steps = 0;
    while (this.accUs >= this.stepUs && steps < this.maxSubsteps) {
      this.accUs -= this.stepUs;
      steps += 1;
    }

    // Drop-time overload policy: if steps are still owed after the cap, discard
    // the whole-step debt, keeping only the sub-step remainder (< stepUs).
    if (this.accUs >= this.stepUs) {
      this.accUs %= this.stepUs;
    }

    return steps;
  }

  /**
   * Consume one planned step: returns the stepIndex to pass to fixedTick, then
   * advances the counter (mod 2^32). Call exactly `plan()`-many times.
   */
  consume(): number {
    const index = this.step;
    this.step = (this.step + 1) >>> 0;
    return index;
  }
}
