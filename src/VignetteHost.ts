export interface VignetteHost {
  onInit(initPayload: Uint8Array): Promise<void>;
  onAppMessage(payload: Uint8Array): Promise<void>;
  onShutdown(): Promise<void>;
  setSendBytes(fn: (bytes: Uint8Array) => void): void;
}
