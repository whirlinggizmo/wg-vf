import type { Vignette } from './Vignette';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export abstract class BaseVignette implements Vignette {
  private readonly outbox: Uint8Array[] = [];

  abstract init(initPayload: Uint8Array): Promise<void>;
  abstract tick(dtUs: number, frameId: number): Promise<void>;
  abstract fixedTick(stepUs: number, stepIndex: number): Promise<void>;
  abstract handleMessage(payload: Uint8Array): Promise<void>;
  abstract shutdown(): Promise<void>;

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    if (this.outbox.length === 0) {
      console.warn(`[${this.constructor.name}] outboxPop called with empty outbox`);
      return new Uint8Array();
    }
    return this.outbox.shift() as Uint8Array;
  }

  protected pushOutboxBytes(payload: Uint8Array): void {
    this.outbox.push(payload);
  }

  protected pushOutboxJson(payload: unknown): void {
    this.outbox.push(encoder.encode(JSON.stringify(payload)));
  }

  protected parseJson<T>(bytes: Uint8Array): T | null {
    try {
      return JSON.parse(decoder.decode(bytes)) as T;
    } catch {
      return null;
    }
  }

  protected clearOutbox(): void {
    this.outbox.length = 0;
  }
}
