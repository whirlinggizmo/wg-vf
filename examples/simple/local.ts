import { VignetteBridge, type VignetteType } from "../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload, encodePayload } from "../codecs/json-codec";

const vignetteType: VignetteType = "js";

function getVignetteUrl(type: VignetteType): string {
  switch (type) {
    case "wasm":
      return new URL(
        "./vignette/wasm/out/simple-vignette_wasm.js",
        import.meta.url,
      ).href;
    case "js":
      return new URL(
        // use the nim generation of js
        //"./vignette/wasm/out/simple-vignette.js",

        // use the pure ts version
        "./vignette/js/simple-vignette.ts",
        import.meta.url,
      ).href;
  }
}

const bridge = new VignetteBridge();

await bridge.connect({
  mode: "local",
  vignetteType,
  moduleUrl: getVignetteUrl(vignetteType),
});

await bridge.init(encodePayload({ userId: "Bob" }));
await bridge.handleMessage(encodePayload({ type: "SpawnPlayer" }));

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
}, 30 / 1000);


const timeoutDuration = 5000;
console.log(`[app] setting disconnect timeout for ${timeoutDuration} ms`);
setTimeout(async () => {
  console.log("[app] test timeout reached, disconnecting from vignette");
  clearInterval(checkMessagesInterval);
  await bridge.disconnect();
}, 5000);
