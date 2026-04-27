import { VignetteBridge, type VignetteType } from "../../src";
// Swap this import to use a different codec (msgpack, protobuf, etc.)
import { decodePayload, encodePayload } from "../codecs/json-codec";
import { config } from "./config";


export type LocalConnectOptions = {
  mode: "local";
  vignetteType: VignetteType;
  moduleUrl: string;
};

export type RemoteConnectOptions = {
  mode: "remote";
  remoteUrl: string;
};

export abstract class BaseApp {
  protected bridge = new VignetteBridge();

  protected getVignetteUrl(type: VignetteType): string {
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

  protected get vignetteType(): VignetteType {
    return config.vignetteType;
  }

  abstract getConnectOptions(): LocalConnectOptions | RemoteConnectOptions;
  abstract getInitPayload(): Uint8Array;

  protected log(...args: any[]) {
    console.log(`[app-base]`, ...args);
  }

  // Optional hook for subclasses to add extra setup (e.g., ping intervals)
  protected onConnected?(): void;

  // Optional hook for subclasses to clean up before disconnect
  protected onDisconnect?(): void;

  async run(): Promise<void> {
    await this.bridge.connect(this.getConnectOptions());
    await this.bridge.init(this.getInitPayload());
    await this.bridge.handleMessage(encodePayload({ type: "SpawnPlayer" }));

    // Optional extra setup (e.g., remote adds ping)
    this.onConnected?.();

    let messagesReceived = 0;
    const checkMessagesInterval = setInterval(() => {
      const messages = this.bridge.pollOutbox();
      if (messages.length > 0) {
        messagesReceived += messages.length;
        for (const payload of messages) {
          this.log(
            "received message from vignette:",
            decodePayload(payload),
          );
        }
      }
    }, 30 / 1000);

    const timeoutDuration = 5000;
    this.log(`setting disconnect timeout for ${timeoutDuration} ms`);
    setTimeout(async () => {
      this.log("test timeout reached, disconnecting from vignette");
      clearInterval(checkMessagesInterval);
      // Cleanup subclass resources before disconnect
      this.onDisconnect?.();
      await this.bridge.disconnect();
    }, 5000);
  }
}
