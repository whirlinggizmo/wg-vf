import type { Vignette } from '../../../src';

export default class EchoVignette implements Vignette {
  private readonly outbox: Uint8Array[] = [];

  async init(_initPayload: Uint8Array): Promise<void> {
    // no-op for example
  }

  async tick(_dtUs: number, _frameId: number): Promise<void> {
    // no-op for example
  }

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {
    // no-op for example
  }

  async handleMessage(payload: Uint8Array): Promise<void> {
    this.outbox.push(payload.slice());
  }

  async shutdown(): Promise<void> {
    this.outbox.length = 0;
  }

  outboxHasMessages(): boolean {
    return this.outbox.length > 0;
  }

  outboxPop(): Uint8Array {
    const msg = this.outbox.shift();
    if (!msg) {
      throw new Error('EchoVignette outbox is empty');
    }
    return msg;
  }
}

export function createVignette(): Vignette {
  return new EchoVignette();
}
