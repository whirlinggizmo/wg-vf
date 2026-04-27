import { encodePayload } from "../codecs/json-codec";
import { BaseApp, type LocalConnectOptions } from "./app-base";

class LocalApp extends BaseApp {
  getConnectOptions(): LocalConnectOptions {
    return {
      mode: "local",
      vignetteType: this.vignetteType,
      moduleUrl: this.getVignetteUrl(this.vignetteType),
    };
  }

  getInitPayload(): Uint8Array {
    return encodePayload({ userId: "Bob" });
  }
}

await new LocalApp().run();
