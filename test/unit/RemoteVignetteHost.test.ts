import { describe, expect, test } from 'bun:test';

import {
  RemoteVignetteHost,
  decodeEnvelope,
  decodeErrorPayload,
  MessageKind,
  SystemType,
} from '../../src';

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
});
