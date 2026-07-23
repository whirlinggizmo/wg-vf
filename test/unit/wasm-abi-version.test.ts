// The host↔sim ABI version guard: createWasmInstance refuses a vignette built
// against a different (or pre-versioning) wg_vf ABI, so a stale .wasm/.so fails
// loudly instead of corrupting memory. Pure mock — no real wasm needed.

import { describe, expect, test } from 'bun:test';

import { createWasmInstance, WG_VF_ABI_VERSION, type WasmVignetteInstance } from '../../src/vignettes/WasmVignette.js';

function stubModule(over: Partial<WasmVignetteInstance> = {}): WasmVignetteInstance {
  const zero = () => 0;
  return {
    HEAPU8: new Uint8Array(64),
    _vf_abi_version: () => WG_VF_ABI_VERSION,
    _vf_init: zero,
    _vf_tick: zero,
    _vf_fixed_tick: zero,
    _vf_handle_message: zero,
    _vf_peer_joined: zero,
    _vf_peer_left: zero,
    _vf_shutdown: zero,
    _vf_outbox_offset: zero,
    _vf_frame_offset: zero,
    _vf_frame_len: zero,
    _vf_frame_seq: zero,
    _vf_mem_alloc: zero,
    ...over,
  };
}

describe('WASM ABI version guard', () => {
  test('accepts a module reporting the matching ABI version', () => {
    expect(() => createWasmInstance(stubModule())).not.toThrow();
  });

  test('rejects a module reporting a different ABI version', () => {
    expect(() => createWasmInstance(stubModule({ _vf_abi_version: () => WG_VF_ABI_VERSION + 1 }))).toThrow(
      /ABI mismatch/,
    );
  });

  test('rejects a module with no vf_abi_version (predates versioning)', () => {
    const m = stubModule();
    delete (m as { _vf_abi_version?: unknown })._vf_abi_version;
    expect(() => createWasmInstance(m)).toThrow(/ABI mismatch/);
  });
});
