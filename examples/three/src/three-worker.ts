// Worker entry: a stock vf worker host driven by a manifest. No bespoke
// vignette-loading here — the framework resolves the id the app names against
// this manifest and loads the js/wasm module itself (Part I §3.1, Part II §4).
// The app selects the binding by naming "three-js" or "three-wasm" in Init.

import {
  runWorkerHost,
  indexedDbDurableStore,
  type Manifest,
  type MessagePortLike,
} from "../../../src";

const config = {
  version: "1.0.0",
  fixedStepUs: 16_666,
  maxSubsteps: 4,
  maxPeers: 8,
  reconnectGraceMs: 0,
  emptyGraceMs: 0,
} as const;

const manifest: Manifest = {
  vignettes: {
    "three-js": {
      ...config,
      type: "js",
      module: new URL("../vignette/ts/out/three-vignette.js", import.meta.url).href,
    },
    "three-wasm": {
      ...config,
      type: "wasm",
      module: new URL("../vignette/nim/out/three-vignette_wasm.js", import.meta.url).href,
    },
  },
};

// Persist the sim to IndexedDB (available inside a Worker), keyed by a stable
// scope, so the world survives a page reload / browser restart. The scope comes
// from `?save=<slot>` on the worker URL (default "default") — pick a fresh slot
// to start a new world, or reuse one to continue it. Restore happens before the
// vignette's init; see the author guide §13 and docs/vignette-fs-abi.md.
const saveSlot = new URL(self.location.href).searchParams.get("save") ?? "default";

runWorkerHost(self as unknown as MessagePortLike, manifest, {
  durableStore: indexedDbDurableStore(),
  storageKey: saveSlot,
});
