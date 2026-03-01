import {
  ReconnectingWebSocketTransport,
  VignetteClientImpl,
  type VignetteType,
} from "../src";
import { decodeJsonPayload, encodeJsonPayload } from "./codec";

// Example app that talks to a remote vignette host over WebSocket.
// It mirrors local-app.ts on the client side, but uses a reconnecting socket
// transport instead of spinning up a local Worker host.

// Choose which vignette implementation the remote host should load.
const vignetteType: VignetteType = "js";

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
      return new URL("./vignettes/echo-js/echo-vignette.ts", import.meta.url)
        .href;
    default:
      throw new Error(`Unknown vignetteType: ${type}`);
  }
}

const vignetteUrl = getVignetteUrl(vignetteType);

// Reconnecting transport keeps retrying when the server is down or restarted.
const transport = new ReconnectingWebSocketTransport({
  url: "ws://localhost:8787",
  maxDelayMs: 3000,
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

// Initiates INIT -> READY handshake (and reconnection re-init is automatic).
await vc.connect(
  encodeJsonPayload({
    vignetteType: vignetteType,
    vignetteUrl: vignetteUrl,
    initPayload: { userId: "Bob" },
  }),
);
