import { VignetteClientImpl, WorkerTransport, type VignetteType } from "../src";
import { decodeJsonPayload, encodeJsonPayload } from "./codec";

// Example app that runs a vignette in local mode using a Web Worker host.
// It mirrors remote-app.ts on the client side, but uses WorkerTransport and
// creates the host worker directly instead of connecting over WebSocket.

// Choose which vignette implementation the worker should host.
const vignetteType: VignetteType = "js";

// the location of the vignette worker.
// Note that this is the worker that hosts the vignette, not the vignette itself.
const workerEntryUrl = new URL("../src/VignetteWorker.ts", import.meta.url);

function getVignetteUrl(type: VignetteType): string {
  switch (type) {
    case "wasm":
      // WASM vignette Emscripten loader:
      return new URL(
        "./vignettes/echo-wasm/out/echo-vignette_wasm.js",
        import.meta.url,
      ).href;
    case "js":
      // JS vignette module:
      return new URL(
        "./vignettes/echo-js/echo-vignette.ts",
        import.meta.url,
      ).href;
    default:
      throw new Error(`Unknown vignetteType: ${type}`);
  }
}

// get the url for the actual vignette
const vignetteUrl = getVignetteUrl(vignetteType);

// Start the reusable worker host entrypoint.
const worker = new Worker(workerEntryUrl.href, {
  type: "module",
});

// Loopback byte transport between app thread and worker host.
const transport = new WorkerTransport({
  worker,
});

// App-facing client API.
const vc = new VignetteClientImpl({ transport });

// App callbacks.
vc.onReady((ready) => {
  if (!ready) {
    console.log("[client] vignette not ready");
    return;
  }
  console.log("[client] vignette ready");
  vc.send(encodeJsonPayload({ type: "SpawnPlayer" }));
});

vc.onMessage((payload) => {
  console.log("[client] received message from vignette:", decodeJsonPayload(payload));
});

vc.onError((err) => {
  console.error("[client] received error from vignette:", err);
});

// Initiates INIT -> READY handshake.
await vc.connect(
  encodeJsonPayload({
      vignetteType: vignetteType,
      vignetteUrl: vignetteUrl,
      initPayload: { userId: "Bob" },
    })
);

// Connection established; continue to watch onReady for readiness changes.
