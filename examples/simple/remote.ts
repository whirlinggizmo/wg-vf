import { VignetteBridge, type VignetteType } from "../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload, encodePayload } from "../codecs/json-codec";

const vignetteType: VignetteType = "wasm";

function getVignetteUrl(type: VignetteType): string {
  switch (type) {
    case "wasm":
      return new URL(
        "./vignette/wasm/out/simple-vignette_wasm.js",
        import.meta.url,
      ).href;
    case "js":
      return new URL("./vignette/js/simple-vignette.ts", import.meta.url).href;
  }
}

/*
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
*/

const bridge = new VignetteBridge();

await bridge.connect({
  mode: "remote",
  remoteUrl: "ws://localhost:8787",
});

await bridge.init(
  encodePayload({
    vignetteType,
    vignetteUrl: getVignetteUrl(vignetteType),
    initPayload: { userId: "Bob" },
  }),
);

bridge.handleMessage(encodePayload({ type: "SpawnPlayer" }));

let pingInterval = setInterval(() => {
  if (bridge.isConnected()) {
    bridge
      .ping()
      .then((result) => {
        console.log(`[bridge] ping: ${result.rttMs}ms`);
      })
      .catch((reason) => {
        console.log(`[app] ping failed: ${reason}`);
      });
  }
}, 5000);

let messagesReceived = 0;
let checkMessagesInterval = setInterval(() => {
  const messages = bridge.pollOutbox();
  if (messages.length > 0) {
    messagesReceived += messages.length;
    for (const payload of messages) {
      console.log(
        "[bridge] received message from vignette:",
        decodePayload(payload),
      );
    }
  }
}, 30/1000);

//await sleep(8000);

const timeoutDuration = 5000;
console.log(`[app] setting disconnect timeout for ${timeoutDuration} ms`);
setTimeout(async () => {
  console.log("[app] test timeout reached, disconnecting from vignette");
  clearInterval(checkMessagesInterval);
  clearInterval(pingInterval);
  await bridge.disconnect();
}, 5000);
