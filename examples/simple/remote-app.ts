import { encodePayload } from "../codecs/json-codec";
import { BaseApp, type RemoteConnectOptions } from "./app-base";

class RemoteApp extends BaseApp {
  private pingInterval?: ReturnType<typeof setInterval>;
  
  protected override log(...args: any[]) {
    console.log(`[remote-app]`, ...args);
  }
  
  getConnectOptions(): RemoteConnectOptions {
    return {
      mode: "remote",
      remoteUrl: "ws://localhost:8787",
    };
  }

  getInitPayload(): Uint8Array {
    return encodePayload({
      vignetteType: this.vignetteType,
      vignetteUrl: this.getVignetteUrl(this.vignetteType),
      initPayload: { userId: "Bob" },
    });
  }

  protected override onConnected(): void {
    this.pingInterval = setInterval(() => {
      if (this.bridge.isConnected()) {
        this.bridge
          .ping()
          .then((result) => {
            this.log(`ping: ${result.rttMs}ms`);
          })
          .catch((reason) => {
            this.log(`ping failed: ${reason}`);
          });
      }
    }, 5000);
  }

  protected override onDisconnect(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
  }
}

await new RemoteApp().run();
