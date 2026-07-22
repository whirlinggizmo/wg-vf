// Worker entry: runs a VignetteHost inside this worker, bridging the worker
// port (`self`) to the host. The main thread talks to it over the ordinary
// envelope protocol — identical to the remote path, just postMessage instead of
// a socket.

import { runWorkerHost, type MessagePortLike } from "../../src";
import { createVignette } from "./vignette/js/simple-vignette";

runWorkerHost(self as unknown as MessagePortLike, {
  vignetteId: "simple",
  version: "1.0.0",
  fixedStepUs: 16_666,
  maxSubsteps: 4,
  maxPeers: 8,
  reconnectGraceMs: 0,
  emptyGraceMs: 0,
  create: () => createVignette(),
});

console.log("[worker] host running");
