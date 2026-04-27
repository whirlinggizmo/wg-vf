import { encodePayload } from "../codecs/json-codec";
import { BaseApp, type LocalConnectOptions } from "./app-base";

class LocalApp extends BaseApp {

  protected override log(...args: any[]) {
    console.log(`[local-app]`, ...args);
  }

  getConnectOptions(): LocalConnectOptions {
    return {
      mode: "local",
      vignetteType: this.vignetteType,
      moduleUrl: this.moduleUrl,
    };
  }

  getInitPayload(): Uint8Array {
    return encodePayload({ userId: "Bob" });
  }
}

await new LocalApp().run();

