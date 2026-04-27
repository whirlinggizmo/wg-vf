import { describe, expect, test } from 'bun:test';

import {
  LocalVignetteHost,
  decodeErrorPayload,
  decodeEnvelope,
  decodeReadyPayload,
  BaseVignette,
  MessageKind,
  SystemType,
} from '../../src';
import { decodeJsonPayload } from '../../examples/codec';

class UnitTestVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {}

  async tick(_dtUs: number, _frameId: number): Promise<void> {}

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}

  async handleMessage(payload: Uint8Array): Promise<void> {
    this.pushOutboxBytes(payload.slice());
  }

  async shutdown(): Promise<void> {}
}

class ThrowingVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {}

  async tick(_dtUs: number, _frameId: number): Promise<void> {}

  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}

  async handleMessage(_payload: Uint8Array): Promise<void> {
    throw new Error('boom');
  }

  async shutdown(): Promise<void> {}
}

class ThrowingInitVignette extends BaseVignette {
  async init(_initPayload: Uint8Array): Promise<void> {
    throw new Error('init failed');
  }

  async tick(_dtUs: number, _frameId: number): Promise<void> {}
  async fixedTick(_stepUs: number, _stepIndex: number): Promise<void> {}
  async handleMessage(_payload: Uint8Array): Promise<void> {}
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

describe('LocalVignetteHost', () => {
  test('emits ready and forwards vignette outbox payloads', async () => {
    const emitted: Uint8Array[] = [];
    const host = new LocalVignetteHost({
      vignetteFactory: async () => new UnitTestVignette(),
      vignetteType: 'js',
    });

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await host.onInit(new Uint8Array());
    expect(emitted.length).toBeGreaterThan(0);

    const readyEnvelope = decodeEnvelope(emitted.shift()!);
    expect(readyEnvelope.messageKind).toBe(MessageKind.System);
    expect(readyEnvelope.systemType).toBe(SystemType.Ready);
    expect(decodeReadyPayload(readyEnvelope.payload)).toEqual({
      ready: true,
      vignetteType: 'js',
    });

    const message = new TextEncoder().encode(JSON.stringify({ type: 'echo', n: 1 }));
    await host.onAppMessage(message);

    const appEnvelope = decodeEnvelope(emitted.shift()!);
    expect(appEnvelope.messageKind).toBe(MessageKind.App);
    expect(decodeJsonPayload(appEnvelope.payload)).toEqual({ type: 'echo', n: 1 });

    await host.onShutdown();
  });

  test('emits error when init throws', async () => {
    const emitted: Uint8Array[] = [];
    const host = new LocalVignetteHost({
      vignetteFactory: async () => new ThrowingInitVignette(),
      vignetteType: 'js',
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
    const host = new LocalVignetteHost({
      vignetteFactory: async () => new ThrowingVignette(),
      vignetteType: 'js',
    });

    host.setSendBytes((bytes) => {
      emitted.push(bytes.slice());
    });

    await host.onInit(new Uint8Array());
    emitted.length = 0;

    await expect(host.onAppMessage(new Uint8Array())).rejects.toThrow('boom');

    expect(emitted.length).toBe(1);
    const errorEnvelope = decodeEnvelope(emitted[0]!);
    expect(errorEnvelope.messageKind).toBe(MessageKind.System);
    expect(errorEnvelope.systemType).toBe(SystemType.Error);
    expect(decodeErrorPayload(errorEnvelope.payload)).toEqual({ message: 'boom' });

    await host.onAppMessage(new Uint8Array());
    expect(emitted.length).toBe(1);
  });

  test('propagates shutdown errors but host is still closed', async () => {
    const emitted: Uint8Array[] = [];
    const host = new LocalVignetteHost({
      vignetteFactory: async () => new ThrowingShutdownVignette(),
      vignetteType: 'js',
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
