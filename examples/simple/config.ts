import type { VignetteType } from "../../src";

// Edit this to configure the example
export const config = {
  vignetteType: "js" as VignetteType, // or "wasm"
  remoteUrl: "ws://localhost:8787",
  // Override to use a custom vignette URL (defaults based on vignetteType if not set)
  moduleUrl: undefined as string | undefined,
};
