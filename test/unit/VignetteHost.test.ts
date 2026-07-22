// Runs the reusable host conformance battery (src/testing/conformance.ts)
// against the reference VignetteHost. A new host implementation gets the whole
// battery by supplying its own `makeHost` factory here.

import { describe, test } from 'bun:test';

import { VignetteHost } from '../../src/hosts/VignetteHost.js';
import { hostConformanceCases, type MakeHost } from '../../src/testing/conformance.js';

const makeHost: MakeHost = (vignetteId, entry, clock) => VignetteHost.single(vignetteId, entry, clock);

describe('VignetteHost conformance', () => {
  for (const c of hostConformanceCases(makeHost)) {
    test(`${c.id} — ${c.title}`, () => c.run());
  }
});
