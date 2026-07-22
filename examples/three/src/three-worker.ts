// Worker entry: runs the host inside this worker (single-player / local path).
// The vignette type (js | wasm) is taken from the worker's name. The main
// thread talks to it over the ordinary envelope protocol via messagePortBytePeer.

import {
  runWorkerHost,
  createWasmInstance,
  type MessagePortLike,
  type HostVignetteEntry,
  type Vignette,
  type WasmVignetteInstance,
} from "../../../src";
import ThreeVignette from "../vignette/ts/three-vignette";

async function createVignette(): Promise<Vignette> {
  const type = (self as unknown as { name?: string }).name || "js";
  if (type === "wasm") {
    // Built artifact (emscripten ES6). Computed path so tsc/vite don't resolve
    // it at build time — it only needs to exist when the wasm option is used.
    const modPath = "../vignette/nim/out/three-vignette_wasm.js";
    const factory = (await import(/* @vite-ignore */ modPath)).default as () => Promise<WasmVignetteInstance>;
    return createWasmInstance(await factory());
  }
  return new ThreeVignette();
}

const entry: HostVignetteEntry = {
  vignetteId: "three",
  version: "1.0.0",
  fixedStepUs: 16_666,
  maxSubsteps: 4,
  maxPeers: 8,
  reconnectGraceMs: 0,
  emptyGraceMs: 0,
  create: createVignette,
};

runWorkerHost(self as unknown as MessagePortLike, entry);
