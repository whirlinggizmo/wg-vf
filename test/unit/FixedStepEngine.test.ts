// Conformance: fixed-step contract (docs/architecture-part1.md §2.3, test plan
// §2.2 ABI-07..12) at the engine level. These are the determinism core; the
// host-driven variants (via runHostConformance) land with the v2 host.

import { describe, expect, test } from 'bun:test';

import { FixedStepEngine } from '../../src/hosts/FixedStepEngine.js';

const STEP = 16_666;
const MAX = 4;

/** Run one iteration: plan dt, consume that many steps, return their indices. */
function iterate(engine: FixedStepEngine, dtUs: number): number[] {
  const n = engine.plan(dtUs);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) indices.push(engine.consume());
  return indices;
}

describe('ABI-07 exactness', () => {
  test('every step is exactly stepUs regardless of awkward dt splits', () => {
    // High substep cap so this isolates exactness, not the overload clamp.
    const engine = new FixedStepEngine(STEP, 1_000_000);
    // The engine reports step COUNTS; each is contractually stepUs. Verify the
    // count math is exact by feeding prime-ish deltas and checking totals.
    let totalSteps = 0;
    let fed = 0;
    for (const dt of [7919, 104729, 1299709, 15485863, 2, 999983]) {
      totalSteps += engine.plan(dt);
      fed += dt;
    }
    // With no overload (deltas below maxSubsteps*STEP each), consumed time is
    // totalSteps*STEP and the remainder is < STEP.
    expect(totalSteps).toBe(Math.floor(fed / STEP));
    expect(engine.pendingUs).toBe(fed - totalSteps * STEP);
    expect(engine.pendingUs).toBeLessThan(STEP);
  });
});

describe('ABI-08 monotonicity', () => {
  test('stepIndex increments by exactly 1 per consumed step, no gaps/repeats', () => {
    const engine = new FixedStepEngine(STEP, 1_000_000);
    let expected = 0;
    for (let chunk = 0; chunk < 50; chunk++) {
      for (const idx of iterate(engine, STEP * 1000)) {
        expect(idx).toBe(expected);
        expected++;
      }
    }
    expect(expected).toBe(50 * 1000);
    expect(engine.stepIndex).toBe(50 * 1000);
  });
});

describe('ABI-09 accumulator', () => {
  test('advancing by k*step + r across varied splits yields exactly k steps, remainder carries', () => {
    const engine = new FixedStepEngine(STEP, 1_000_000);
    const k = 37;
    const r = 5_000; // < STEP
    // Feed the same total (k*STEP + r) split three different ways.
    const total = k * STEP + r;
    let stepsA = 0;
    stepsA += engine.plan(total);
    expect(stepsA).toBe(k);
    expect(engine.pendingUs).toBe(r);

    const engine2 = new FixedStepEngine(STEP, 1_000_000);
    let stepsB = 0;
    stepsB += engine2.plan(STEP * 10);
    stepsB += engine2.plan(STEP * 20 + r);
    stepsB += engine2.plan(STEP * 7);
    expect(stepsB).toBe(k);
    expect(engine2.pendingUs).toBe(r);
  });
});

describe('ABI-10/11 overload clamp & drop-time', () => {
  test('ABI-10: advancing by (maxSubsteps + 3)*step in one plan yields exactly maxSubsteps', () => {
    const engine = new FixedStepEngine(STEP, MAX);
    const n = engine.plan((MAX + 3) * STEP);
    expect(n).toBe(MAX);
  });

  test('ABI-11: after overload the accumulator holds < step; debt does not carry', () => {
    const engine = new FixedStepEngine(STEP, MAX);
    engine.plan((MAX + 3) * STEP);
    for (let i = 0; i < MAX; i++) engine.consume();

    expect(engine.pendingUs).toBeLessThan(STEP);
    // Next iteration with dt=0 -> zero steps (no carried debt).
    expect(engine.plan(0)).toBe(0);
    // Next iteration with dt=step -> exactly one step.
    expect(engine.plan(STEP)).toBe(1);
  });

  test('drop-time keeps sub-step phase remainder while discarding whole-step debt', () => {
    const engine = new FixedStepEngine(STEP, MAX);
    const r = 1_234;
    // (MAX + 1) whole steps + r: run MAX, one whole step is dropped, r survives.
    const n = engine.plan((MAX + 1) * STEP + r);
    expect(n).toBe(MAX);
    expect(engine.pendingUs).toBe(r);
  });
});

describe('ABI-12 wraparound', () => {
  test('stepIndex wraps 0xFFFFFFFE -> 0xFFFFFFFF -> 0 -> 1 with no gap or repeat', () => {
    // Seed near the u32 boundary so the wrap is reachable without 2^32 steps.
    const engine = new FixedStepEngine(STEP, 1_000_000, 0xfffffffe);
    const indices = iterate(engine, STEP * 4);
    expect(indices).toEqual([0xfffffffe, 0xffffffff, 0, 1]);
    expect(engine.stepIndex).toBe(2);
  });
});

describe('constructor guards', () => {
  test('rejects non-positive stepUs and negative maxSubsteps', () => {
    expect(() => new FixedStepEngine(0, 4)).toThrow(RangeError);
    expect(() => new FixedStepEngine(STEP, -1)).toThrow(RangeError);
  });

  test('maxSubsteps of 0 never runs a step (sim frozen)', () => {
    const engine = new FixedStepEngine(STEP, 0);
    expect(engine.plan(STEP * 100)).toBe(0);
    expect(engine.pendingUs).toBeLessThan(STEP);
  });
});
