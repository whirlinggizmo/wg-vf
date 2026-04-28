import { BaseApp, type LocalConnectOptions } from "./app-base";
import { encodePayload } from "../../codecs/json-codec";
import type { VignetteType } from "../../../src";

export class LocalApp extends BaseApp {
  constructor(vignetteType: VignetteType) {
    super(vignetteType);
  }

  getConnectOptions(): LocalConnectOptions {
    return {
      mode: "local",
      vignetteType: this.vignetteType,
      moduleUrl: this.getVignetteUrl(this.vignetteType),
    };
  }

  getInitPayload(): Uint8Array {
    return encodePayload({
      type: "Init",
      scene: "three-demo",
      timestamp: Date.now(),
    });
  }
}
