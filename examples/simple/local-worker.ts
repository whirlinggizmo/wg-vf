// Worker entry: a stock vf worker host driven by a manifest. The worker imports
// no vignette — the framework resolves the id the app names ("simple") against
// this manifest and loads the module itself (Part I §3.1, Part II §4).

import { runWorkerHost, singleVignetteManifest, type MessagePortLike } from "../../src";

runWorkerHost(
  self as unknown as MessagePortLike,
  singleVignetteManifest("simple", {
    version: "1.0.0",
    fixedStepUs: 16_666,
    maxSubsteps: 4,
    maxPeers: 8,
    reconnectGraceMs: 0,
    emptyGraceMs: 0,
    type: "js",
    module: new URL("./vignette/js/simple-vignette.ts", import.meta.url).href,
  }),
);
