// Conformance: Envelope v2 (docs/architecture-part1.md §1, test plan §1).
// IDs reference the assertions in docs/conformance-test-plan.md.

import { describe, expect, test } from 'bun:test';

import {
  Channel,
  SystemType,
  ErrorCode,
  DecodeErrorReason,
  EnvelopeDecodeError,
  ENVELOPE_VERSION,
  HEADER_SIZE,
  DEFAULT_MAX_PAYLOAD_BYTES,
  encodeEnvelope,
  encodeSystemEnvelope,
  encodeAppEnvelope,
  encodeFrameEnvelope,
  decodeEnvelope,
  readFrameHeader,
  frameSeqIsNewer,
  encodeReadyPayload,
  decodeReadyPayload,
  encodeErrorPayload,
  decodeErrorPayload,
  encodeJoinPayload,
  decodeJoinPayload,
  encodeInitPayload,
  decodeInitPayload,
  encodePingPayload,
  decodePingPayload,
} from '../../src/envelope/index.js';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('ENV-01/03 layout & golden bytes', () => {
  test('ENV-03: header fields land at the specified offsets, little-endian', () => {
    const bytes = encodeSystemEnvelope(SystemType.Ping, new Uint8Array([0xaa, 0xbb]), 0x0102);
    // version=2, channel=System(0), flags=0, reserved=0, systemType=7 (Ping),
    // clientId=0x0102, payloadLen=2, payload=aabb
    expect(hex(bytes)).toBe('02000000' + '0700' + '0201' + '02000000' + 'aabb');
    expect(bytes[0]).toBe(ENVELOPE_VERSION);
    expect(bytes.length).toBe(HEADER_SIZE + 2);
  });

  test('ENV-01: App and Frame envelopes encode to byte-exact golden output', () => {
    const app = encodeAppEnvelope(new Uint8Array([1, 2, 3]), 5);
    // channel=App(1), systemType=0, clientId=5, len=3
    expect(hex(app)).toBe('02010000' + '0000' + '0500' + '03000000' + '010203');

    const frame = encodeFrameEnvelope(new Uint8Array([0xff]), 0x11223344, 0x55667788, 0);
    // channel=Frame(2), payload = frameSeq LE + sourceTick LE + body(ff) = 9 bytes
    expect(hex(frame)).toBe('02020000' + '0000' + '0000' + '09000000' + '44332211' + '88776655' + 'ff');
  });

  test('ENV-01: zero-length payload', () => {
    const bytes = encodeSystemEnvelope(SystemType.Shutdown);
    expect(hex(bytes)).toBe('02000000' + '0500' + '0000' + '00000000');
    expect(bytes.length).toBe(HEADER_SIZE);
  });
});

describe('ENV-02 round-trip', () => {
  test('every channel round-trips to the expected structured form', () => {
    const app = decodeEnvelope(encodeAppEnvelope(new Uint8Array([9, 8, 7]), 42));
    expect(app.channel).toBe(Channel.App);
    expect(app.systemType).toBe(0);
    expect(app.clientId).toBe(42);
    expect(Array.from(app.payload)).toEqual([9, 8, 7]);

    const sys = decodeEnvelope(encodeSystemEnvelope(SystemType.Ready, new Uint8Array([1]), 7));
    expect(sys.channel).toBe(Channel.System);
    expect(sys.systemType).toBe(SystemType.Ready);
    expect(sys.clientId).toBe(7);

    const frameBytes = encodeFrameEnvelope(new Uint8Array([1, 2]), 100, 200, 3);
    const frame = decodeEnvelope(frameBytes);
    expect(frame.channel).toBe(Channel.Frame);
    const fh = readFrameHeader(frame.payload);
    expect(fh).not.toBeNull();
    expect(fh!.frameSeq).toBe(100);
    expect(fh!.sourceTick).toBe(200);
    expect(Array.from(fh!.body)).toEqual([1, 2]);
  });
});

describe('ENV-04..08 strict decode rejects', () => {
  function reasonOf(bytes: Uint8Array, maxPayloadBytes?: number): DecodeErrorReason {
    try {
      decodeEnvelope(bytes, maxPayloadBytes ? { maxPayloadBytes } : {});
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeDecodeError);
      return (err as EnvelopeDecodeError).reason;
    }
    throw new Error('expected decode to throw');
  }

  test('ENV-04: version !== 2 rejected as UnsupportedVersion', () => {
    const bytes = encodeAppEnvelope(new Uint8Array([1]));
    bytes[0] = 1;
    expect(reasonOf(bytes)).toBe(DecodeErrorReason.UnsupportedVersion);
  });

  test('ENV-05: nonzero flags or reserved byte rejected', () => {
    const withFlags = encodeAppEnvelope(new Uint8Array([1]));
    withFlags[2] = 0b0000_0001;
    expect(reasonOf(withFlags)).toBe(DecodeErrorReason.BadFlags);

    const withReserved = encodeAppEnvelope(new Uint8Array([1]));
    withReserved[3] = 1;
    expect(reasonOf(withReserved)).toBe(DecodeErrorReason.BadReserved);
  });

  test('ENV-06: channel outside {0,1,2} rejected', () => {
    const bytes = encodeAppEnvelope(new Uint8Array([1]));
    bytes[1] = 3;
    expect(reasonOf(bytes)).toBe(DecodeErrorReason.BadChannel);
  });

  test('ENV-07: nonzero systemType on App/Frame rejected; unknown systemType on System rejected', () => {
    const app = encodeAppEnvelope(new Uint8Array([1]));
    const view = new DataView(app.buffer, app.byteOffset, app.byteLength);
    view.setUint16(4, 5, true); // systemType nonzero on App
    expect(reasonOf(app)).toBe(DecodeErrorReason.BadSystemType);

    const sys = encodeSystemEnvelope(SystemType.Ping);
    const sview = new DataView(sys.buffer, sys.byteOffset, sys.byteLength);
    sview.setUint16(4, 999, true); // unknown systemType
    expect(reasonOf(sys)).toBe(DecodeErrorReason.BadSystemType);
  });

  test('ENV-08: payloadLen disagreeing with actual length rejected (short and long), no over-read', () => {
    const base = encodeAppEnvelope(new Uint8Array([1, 2, 3]));
    const short = base.slice(0, base.length - 1); // buffer shorter than header claims
    expect(reasonOf(short)).toBe(DecodeErrorReason.LengthMismatch);

    const long = new Uint8Array(base.length + 1);
    long.set(base, 0); // trailing extra byte, header still says len=3
    expect(reasonOf(long)).toBe(DecodeErrorReason.LengthMismatch);

    const tooShortForHeader = new Uint8Array(HEADER_SIZE - 1);
    expect(reasonOf(tooShortForHeader)).toBe(DecodeErrorReason.TooShort);
  });

  test('ENV-25: payloadLen over cap rejected before allocation, on every channel', () => {
    // Hand-build a header claiming a 2 MiB payload but carry only the header.
    for (const channel of [Channel.System, Channel.App, Channel.Frame]) {
      const buf = new Uint8Array(HEADER_SIZE);
      const view = new DataView(buf.buffer);
      view.setUint8(0, ENVELOPE_VERSION);
      view.setUint8(1, channel);
      // systemType must be valid on the System channel; use Ping so the cap
      // check is what trips, not systemType validation.
      if (channel === Channel.System) view.setUint16(4, SystemType.Ping, true);
      view.setUint32(8, DEFAULT_MAX_PAYLOAD_BYTES + 1, true);
      expect(reasonOf(buf)).toBe(DecodeErrorReason.PayloadTooLarge);
    }
  });

  test('ENV-25: manifest-overridden lower cap is honored', () => {
    const bytes = encodeAppEnvelope(new Uint8Array(64));
    expect(reasonOf(bytes, 32)).toBe(DecodeErrorReason.PayloadTooLarge);
    // Exactly at cap is allowed.
    expect(() => decodeEnvelope(encodeAppEnvelope(new Uint8Array(32)), { maxPayloadBytes: 32 })).not.toThrow();
  });
});

describe('ENV-17/18 frameSeq modular newer-than', () => {
  test('ENV-17: strictly newer is accepted, equal/older rejected', () => {
    expect(frameSeqIsNewer(5, 4)).toBe(true);
    expect(frameSeqIsNewer(5, 5)).toBe(false);
    expect(frameSeqIsNewer(4, 5)).toBe(false);
  });

  test('ENV-18: comparison is modular across u32 wrap', () => {
    expect(frameSeqIsNewer(0x00000001, 0xfffffffe)).toBe(true);
    expect(frameSeqIsNewer(0xfffffffe, 0x00000001)).toBe(false);
    // Halfway point is treated as "older" (not newer) by the signed rule.
    expect(frameSeqIsNewer((0 + 0x80000000) >>> 0, 0)).toBe(false);
  });
});

describe('§1.5 system payloads round-trip binary', () => {
  test('Ready carries resolved id, version, clientId, fixedStepUs, resumeToken', () => {
    const p = {
      vignetteId: 'restEasy',
      version: '1.2.0',
      clientId: 7,
      fixedStepUs: 16666,
      resumeToken: new Uint8Array([1, 2, 3, 4]),
    };
    expect(decodeReadyPayload(encodeReadyPayload(p))).toEqual(p);

    // Empty token round-trips too (reconnect disabled).
    const noToken = { ...p, resumeToken: new Uint8Array(0) };
    expect(decodeReadyPayload(encodeReadyPayload(noToken))).toEqual(noToken);
  });

  test('Error carries code and message', () => {
    const p = { code: ErrorCode.SessionFull, message: 'full up' };
    expect(decodeErrorPayload(encodeErrorPayload(p))).toEqual(p);
  });

  test('Join carries id and optional resumeToken', () => {
    const noToken = decodeJoinPayload(encodeJoinPayload({ vignetteId: 'restEasy' }));
    expect(noToken).toEqual({ vignetteId: 'restEasy' });
    const withToken = decodeJoinPayload(
      encodeJoinPayload({ vignetteId: 'restEasy', resumeToken: new Uint8Array([1, 2, 3]) }),
    );
    expect(withToken?.vignetteId).toBe('restEasy');
    expect(Array.from(withToken?.resumeToken ?? [])).toEqual([1, 2, 3]);
  });

  test('Init carries id and opaque init bytes', () => {
    const decoded = decodeInitPayload(
      encodeInitPayload({ vignetteId: 'restEasy', initPayload: new Uint8Array([9, 9]) }),
    );
    expect(decoded?.vignetteId).toBe('restEasy');
    expect(Array.from(decoded?.initPayload ?? [])).toEqual([9, 9]);
  });

  test('ENV-23: Ping/Pong echo sequence and sentAtMs', () => {
    const p = { sequence: 42, sentAtMs: 1234.5 };
    expect(decodePingPayload(encodePingPayload(p))).toEqual(p);
  });
});

describe('encoder guards', () => {
  test('clientId beyond u16 is a RangeError', () => {
    expect(() => encodeEnvelope({ channel: Channel.App, clientId: 0x1_0000 })).toThrow(RangeError);
  });
});
