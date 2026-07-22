// Framework-owned vignette module loading (Part II §4/§8). Given a module-form
// manifest entry, import the module and adapt it to a Vignette — this is the
// glue that used to be hand-written in every example's worker.
//
//   - type 'wasm': the module default-exports an emscripten factory
//     (() => Promise<WasmVignetteInstance>); we wrap it with createWasmInstance.
//   - type 'js':   the module default-exports a Vignette class (newable) or a
//     factory (() => Vignette).

import type { Vignette } from '../vignettes/Vignette.js';
import type { ModuleSource } from './Manifest.js';
import { createWasmInstance, type WasmVignetteInstance } from '../vignettes/WasmVignette.js';

type VignetteCtor = new () => Vignette;
type VignetteFactory = () => Vignette | Promise<Vignette>;
type WasmModuleFactory = () => Promise<WasmVignetteInstance>;

function isConstructable(value: unknown): value is VignetteCtor {
  return typeof value === 'function' && 'prototype' in value && (value as VignetteCtor).prototype != null;
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

  // js: a class (newable) or a plain factory.
  if (isConstructable(def)) {
    return new def();
  }
  if (typeof def === 'function') {
    return (def as VignetteFactory)();
  }
  throw new Error(`js vignette '${entry.module}' default export is neither a class nor a factory`);
}
