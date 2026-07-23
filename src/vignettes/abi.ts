// The wg-vf host↔sim ABI version — the one integer every binding agrees on.
// Bump on ANY breaking change to the vf_* signatures, the outbox ring, or the
// frame layout, and keep it in lockstep with `WG_VF_ABI_VERSION` in wg_vf.h.
//
// It is enforced at sim load, per binding:
//   - WASM/native: the module exports `vf_abi_version()`; createWasmInstance
//     refuses a mismatch (a trapped/stale binary can't be trusted).
//   - JS (module form / dynamic import): the loaded Vignette carries `abiVersion`
//     (BaseVignette sets it for free); loadVignetteModule refuses a mismatch.
//   - JS (factory/`create` form): none needed — it's compiled in the same
//     project as the host, so the `Vignette` interface catches drift at build.
export const WG_VF_ABI_VERSION = 1;
