import { BaseVignette } from '../../src';

type InitPayload = {
  userId?: string;
};

type MessagePayload = {
  type?: string;
  [key: string]: unknown;
};

export class TestEchoVignette extends BaseVignette {
  async init(initPayload: Uint8Array): Promise<void> {
    const decoded = this.parseJson<InitPayload>(initPayload) ?? {};
    this.pushOutboxJson({
      type: 'init',
      userId: decoded.userId ?? 'unknown',
    });
  }

  async tick(_dtUs: number, _frameId: number): Promise<void> {}

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}

  async handleMessage(payload: Uint8Array): Promise<void> {
    const decoded = this.parseJson<MessagePayload>(payload) ?? {};
    this.pushOutboxJson({
      type: 'echo',
      payload: decoded,
    });
  }

  async shutdown(): Promise<void> {}
}

export async function createVignette(): Promise<TestEchoVignette> {
  return new TestEchoVignette();
}
