// ENV-09 (test plan §1.1): fuzz the v2 decoder. No throw may escape the defined
// EnvelopeDecodeError path; no hang; no over-read. Uses a seeded PRNG so a
// failure reproduces from the logged seed (test plan §6 version discipline).

import { describe, expect, test } from 'bun:test';

import {
  EnvelopeDecodeError,
  decodeEnvelope,
  encodeAppEnvelope,
  encodeSystemEnvelope,
  SystemType,
} from '../../src/envelope/index.js';

// Small deterministic LCG (Numerical Recipes constants). Math.random is avoided
// so the corpus is reproducible from `seed`.
function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function decodeIsSafe(bytes: Uint8Array): boolean {
  try {
    decodeEnvelope(bytes);
    return true; // a valid buffer decoding cleanly is fine
  } catch (err) {
    if (err instanceof EnvelopeDecodeError) return true;
    return false; // any other throw is a conformance failure
  }
}

describe('ENV-09 decoder fuzz', () => {
  test('random buffers never escape the defined error path', () => {
    const seed = 0x1234_5678;
    const rand = makePrng(seed);
    const iterations = 20_000;

    for (let i = 0; i < iterations; i++) {
      const len = rand() % 40; // spans sub-header and just-past-header sizes
      const buf = new Uint8Array(len);
      for (let j = 0; j < len; j++) buf[j] = rand() & 0xff;
      if (!decodeIsSafe(buf)) {
        throw new Error(`ENV-09 fuzz failed at seed=${seed} iteration=${i}`);
      }
    }
    expect(true).toBe(true);
  });

  test('mutated valid buffers never escape the defined error path', () => {
    const seed = 0x0bad_f00d;
    const rand = makePrng(seed);
    const seeds = [
      encodeAppEnvelope(new Uint8Array([1, 2, 3, 4]), 7),
      encodeSystemEnvelope(SystemType.Ready, new Uint8Array([9, 9]), 1),
      encodeSystemEnvelope(SystemType.Shutdown),
    ];

    for (let i = 0; i < 20_000; i++) {
      const base = seeds[rand() % seeds.length];
      const buf = base.slice();
      // Flip 1–3 random bytes.
      const flips = 1 + (rand() % 3);
      for (let f = 0; f < flips && buf.length > 0; f++) {
        buf[rand() % buf.length] = rand() & 0xff;
      }
      if (!decodeIsSafe(buf)) {
        throw new Error(`ENV-09 mutation fuzz failed at seed=${seed} iteration=${i}`);
      }
    }
    expect(true).toBe(true);
  });
});
