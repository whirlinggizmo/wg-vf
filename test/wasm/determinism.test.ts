// DET-03 / DET-05 (test plan §4): cross-binding determinism under a scripted
// scenario, including an overload segment. The same vignette (counter) and the
// same T-SCRIPT must yield byte-identical observable traces whether the sim is
// TS or Nim-compiled-to-WASM. Skips if the WASM isn't built.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance } from '../../src/vignettes/WasmVignette.js';
import { CounterVignette } from '../../src/testing/vignettes.js';
import { runScript, type ScriptAction } from '../../src/testing/script.js';

type Factory = () => Promise<unknown>;
let counterF: Factory | null = null;
try {
  counterF = ((await import('./out/counter_wasm.js')) as { default: Factory }).default;
} catch {
  counterF = null;
}

const STEP = 16_666;

// S1: multi-peer join/leave churn, a message burst, and an overload pump
// (advance 6 steps with maxSubsteps 4 → drop-time clamp to 4).
function s1(): ScriptAction[] {
  return [
    { op: 'connect', peer: 'P1' },
    { op: 'init', peer: 'P1' },
    { op: 'connect', peer: 'P2' },
    { op: 'join', peer: 'P2' },
    { op: 'advance', us: STEP * 3 },
    { op: 'pump' },
    { op: 'app', peer: 'P1', bytes: new Uint8Array([1]) },
    { op: 'advance', us: STEP },
    { op: 'pump' },
    { op: 'connect', peer: 'P3' },
    { op: 'join', peer: 'P3' },
    { op: 'advance', us: STEP * 6 }, // overload
    { op: 'pump' },
    { op: 'leave', peer: 'P2' },
    { op: 'advance', us: STEP * 2 },
    { op: 'pump' },
    { op: 'drop', peer: 'P3' },
    { op: 'advance', us: STEP },
    { op: 'pump' },
  ];
}

describe('DET-03/05 cross-binding determinism', () => {
  test.skipIf(!counterF)('counter TS and WASM produce byte-identical traces under S1 (incl. overload)', async () => {
    const tsResult = await runScript(() => new CounterVignette(), s1());
    const wasmResult = await runScript(
      async () => createWasmInstance((await counterF!()) as never),
      s1(),
    );

    expect(Object.keys(wasmResult.traces).sort()).toEqual(['P1', 'P2', 'P3']);
    // Every peer's App+Frame stream is byte-identical across the two bindings.
    expect(wasmResult.traces).toEqual(tsResult.traces);
    expect(wasmResult.finalState).toBe(tsResult.finalState);
    // The founding peer saw real frames (non-empty trace) — the scenario ran.
    expect(tsResult.traces.P1.length).toBeGreaterThan(0);
  });

  if (!counterF) {
    test('WASM artifact not built — DET-03/05 skipped', () => {
      expect(true).toBe(true);
    });
  }
});
