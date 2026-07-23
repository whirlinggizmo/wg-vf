// Framework-owned vignette module loading (Part II §4/§8). Given a module-form
// manifest entry, import the module and adapt it to a Vignette — this is the
// glue that used to be hand-written in every example's worker.
//
//   - type 'wasm': the module default-exports an emscripten factory
//     (() => Promise<WasmVignetteInstance>); we wrap it with createWasmInstance.
//   - type 'js':   the module default-exports a Vignette class (newable) or a
//     factory (() => Vignette).

import { WG_VF_ABI_VERSION } from '../vignettes/abi.js';
import type { Vignette } from '../vignettes/Vignette.js';
import type { ModuleSource } from './Manifest.js';
import { createWasmInstance, type WasmVignetteInstance } from '../vignettes/WasmVignette.js';

type VignetteCtor = new () => Vignette;
type VignetteFactory = () => Vignette | Promise<Vignette>;
type WasmModuleFactory = () => Promise<WasmVignetteInstance>;

function isConstructable(value: unknown): value is VignetteCtor {
  return typeof value === 'function' && 'prototype' in value && (value as VignetteCtor).prototype != null;
}

/**
 * Refuse a dynamically-imported JS vignette built against an incompatible ABI —
 * the module-form analogue of the wasm `vf_abi_version()` check (a stale binary
 * that would otherwise load and misbehave). `BaseVignette` sets `abiVersion`;
 * a missing value means the module predates ABI versioning, so it's refused too.
 */
export function assertJsVignetteAbi(vignette: Vignette, source: string): void {
  if (vignette.abiVersion !== WG_VF_ABI_VERSION) {
    throw new Error(
      `wg-vf ABI mismatch: js vignette '${source}' reports ABI ${vignette.abiVersion ?? 'unknown'}, ` +
        `host expects ${WG_VF_ABI_VERSION}. Rebuild it against this version of wg-vf ` +
        `(extend BaseVignette, or set \`readonly abiVersion = WG_VF_ABI_VERSION\`).`,
    );
  }
}

export async function loadVignetteModule(entry: ModuleSource): Promise<Vignette> {
  const mod = (await import(/* @vite-ignore */ entry.module)) as { default: unknown };
  const def = mod.default;

  if (entry.type === 'wasm') {
    if (typeof def !== 'function') {
      throw new Error(`wasm vignette '${entry.module}' has no default export factory`);
    }
    return createWasmInstance(await (def as WasmModuleFactory)());
  }

  // js: a class (newable) or a plain factory — construct, then version-check.
  let vignette: Vignette;
  if (isConstructable(def)) {
    vignette = new def();
  } else if (typeof def === 'function') {
    vignette = await (def as VignetteFactory)();
  } else {
    throw new Error(`js vignette '${entry.module}' default export is neither a class nor a factory`);
  }
  assertJsVignetteAbi(vignette, entry.module);
  return vignette;
}
