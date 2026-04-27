import type { VignetteType } from "../../src";

interface Config {
  vignetteType?: VignetteType; // "wasm" | "js", defaults to "js"
  remoteUrl?: string; // defaults to "ws://localhost:8787"
}

// Edit this to override the defaults
export const config: Config = {
  vignetteType: "js",
  remoteUrl: "ws://localhost:8787",
};
