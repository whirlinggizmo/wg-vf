import { VignetteBridge, type VignetteType } from "../../src";
import { decodeJsonPayload, encodeJsonPayload } from "../codec/json-codec";

const vignetteType: VignetteType = "js";

function getVignetteUrl(type: VignetteType): string {
  switch (type) {
    case "wasm":
      return new URL(
        "../vignettes/echo-wasm/out/echo-vignette_wasm.js",
        import.meta.url,
      ).href;
    case "js":
      return new URL(
        // use the nim generation of js
        //"../vignettes/echo-wasm/out/echo-vignette.js",
        
        // use the pure ts version
        "../vignettes/echo-js/echo-vignette.ts",
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

await bridge.init(encodeJsonPayload({ userId: "Bob" }));
await bridge.handleMessage(encodeJsonPayload({ type: "SpawnPlayer" }));

let messagesReceived = 0;
let checkMessagesInterval = setInterval(() => {
  const messages = bridge.pollOutbox();
  if (messages.length > 0) {
    messagesReceived += messages.length;
    for (const payload of messages) {
      console.log(
        "[bridge] received message from vignette:",
        decodeJsonPayload(payload),
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
