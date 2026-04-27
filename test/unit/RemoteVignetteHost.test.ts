import { describe, expect, test } from 'bun:test';

import {
  RemoteVignetteHost,
  decodeEnvelope,
  decodeErrorPayload,
  MessageKind,
  SystemType,
  BaseVignette,
} from '../../src';

class ThrowingInitVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {
    throw new Error('init failed');
  }
  async tick(_dtUs: number, _frameId: number): Promise<void> {}
  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}
  async handleMessage(_payload: Uint8Array): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class ThrowingVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {}
  async tick(_dtUs: number, _frameId: number): Promise<void> {}
  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}
  async handleMessage(_payload: Uint8Array): Promise<void> {
    throw new Error('handleMessage failed');
  }
  async shutdown(): Promise<void> {}
}

class ThrowingShutdownVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {}
  async tick(_dtUs: number, _frameId: number): Promise<void> {}
  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}
  async handleMessage(_payload: Uint8Array): Promise<void> {}
  async shutdown(): Promise<void> {
    throw new Error('shutdown failed');
  }
}

describe('RemoteVignetteHost', () => {
  test('emits error when init payload is missing required remote fields', async () => {
    const emitted: Uint8Array[] = [];
    const host = new RemoteVignetteHost({});

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await expect(
      host.onInit(new TextEncoder().encode(JSON.stringify({ initPayload: { userId: 'Nope' } }))),
    ).rejects.toThrow('Remote init payload must include vignetteType');

    expect(emitted.length).toBe(1);
    const errorEnvelope = decodeEnvelope(emitted[0]!);
    expect(errorEnvelope.messageKind).toBe(MessageKind.System);
    expect(errorEnvelope.systemType).toBe(SystemType.Error);
    expect(decodeErrorPayload(errorEnvelope.payload)).toEqual({
      message: 'Remote init payload must include vignetteType',
    });
  });

  test('emits error when vignette init throws', async () => {
    const emitted: Uint8Array[] = [];
    const host = new RemoteVignetteHost({
      vignetteFactory: async () => new ThrowingInitVignette(),
    });

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await expect(host.onInit(new Uint8Array())).rejects.toThrow('init failed');

    expect(emitted.length).toBe(1);
    const errorEnvelope = decodeEnvelope(emitted[0]!);
    expect(errorEnvelope.messageKind).toBe(MessageKind.System);
    expect(errorEnvelope.systemType).toBe(SystemType.Error);
    expect(decodeErrorPayload(errorEnvelope.payload)).toEqual({ message: 'init failed' });
  });

  test('emits error and shuts down when handleMessage throws', async () => {
    const emitted: Uint8Array[] = [];
    const host = new RemoteVignetteHost({
      vignetteFactory: async () => new ThrowingVignette(),
    });

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await host.onInit(new Uint8Array());
    emitted.length = 0;

    await expect(host.onAppMessage(new Uint8Array())).rejects.toThrow('handleMessage failed');

    expect(emitted.length).toBe(1);
    const errorEnvelope = decodeEnvelope(emitted[0]!);
    expect(errorEnvelope.messageKind).toBe(MessageKind.System);
    expect(errorEnvelope.systemType).toBe(SystemType.Error);
    expect(decodeErrorPayload(errorEnvelope.payload)).toEqual({ message: 'handleMessage failed' });
  });

  test('propagates shutdown errors', async () => {
    const emitted: Uint8Array[] = [];
    const host = new RemoteVignetteHost({
      vignetteFactory: async () => new ThrowingShutdownVignette(),
    });

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await host.onInit(new Uint8Array());
    emitted.length = 0;

    // Shutdown errors propagate but don't emit an error envelope
    // (the host is already shutting down, no need to signal further)
    await expect(host.onShutdown()).rejects.toThrow('shutdown failed');
  });
});
