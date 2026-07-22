// Worker entry: a stock vf worker host driven by a manifest. No bespoke
// vignette-loading here — the framework resolves the id the app names against
// this manifest and loads the js/wasm module itself (Part I §3.1, Part II §4).
// The app selects the binding by naming "three-js" or "three-wasm" in Init.

import { runWorkerHost, type Manifest, type MessagePortLike } from "../../../src";

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

runWorkerHost(self as unknown as MessagePortLike, manifest);
