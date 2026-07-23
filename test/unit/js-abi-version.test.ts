// The host↔sim ABI guard for the JS module-form (dynamic import) path:
// loadVignetteModule refuses a dynamically-imported vignette built against a
// different (or pre-versioning) wg-vf ABI — the JS analogue of the wasm
// vf_abi_version() check. Tested via the exported guard with plain stubs.

import { describe, expect, test } from 'bun:test';

import { assertJsVignetteAbi } from '../../src/hosts/loadVignetteModule.js';
import { BaseVignette } from '../../src/vignettes/BaseVignette.js';
import { WG_VF_ABI_VERSION } from '../../src/vignettes/abi.js';
import type { Vignette } from '../../src/vignettes/Vignette.js';

function stub(abiVersion: number | undefined): Vignette {
  const noop = () => {};
  return {
    abiVersion,
    init: noop,
    tick: noop,
    fixedTick: noop,
    handleMessage: noop,
    peerJoined: noop,
    peerLeft: noop,
    shutdown: noop,
    outboxHasMessages: () => false,
    outboxPop: () => ({ targetId: 0, payload: new Uint8Array() }),
  };
}

describe('JS vignette ABI version guard', () => {
  test('accepts a vignette reporting the matching ABI version', () => {
    expect(() => assertJsVignetteAbi(stub(WG_VF_ABI_VERSION), 'ok.js')).not.toThrow();
  });

  test('a BaseVignette subclass carries the version for free', () => {
    class Demo extends BaseVignette {}
    expect(new Demo().abiVersion).toBe(WG_VF_ABI_VERSION);
    expect(() => assertJsVignetteAbi(new Demo(), 'demo.js')).not.toThrow();
  });

  test('rejects a vignette reporting a different ABI version', () => {
    expect(() => assertJsVignetteAbi(stub(WG_VF_ABI_VERSION + 1), 'stale.js')).toThrow(/ABI mismatch/);
  });

  test('rejects a vignette with no abiVersion (predates versioning)', () => {
    expect(() => assertJsVignetteAbi(stub(undefined), 'ancient.js')).toThrow(/ABI mismatch/);
  });
});
