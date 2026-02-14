export interface Vignette {
  init(initPayload: Uint8Array): Promise<void>;
  tick(dtUs: number, frameId: number): Promise<void>;
  fixedTick(stepUs: number, stepIndex: number): Promise<void>;
  handleMessage(payload: Uint8Array): Promise<void>;
  shutdown(): Promise<void>;
  outboxHasMessages(): boolean;
  outboxPop(): Uint8Array;
}
