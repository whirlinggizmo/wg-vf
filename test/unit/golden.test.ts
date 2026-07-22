// T-GOLD (test plan §0/§1.1): the golden envelope bytes live in a checked-in
// fixture file (test/fixtures/envelope-golden.json), not inline, so a change to
// any wire byte is a visible diff gated by the doc-versioning rule. Each fixture
// is verified both ways: encode → exact bytes, and decode → structured form.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { Channel, encodeEnvelope, decodeEnvelope } from '../../src/envelope/index.js';

interface Fixture {
  name: string;
  channel: number;
  systemType: number;
  clientId: number;
  payloadHex: string;
  hex: string;
}

const golden = JSON.parse(
  readFileSync(new URL('../fixtures/envelope-golden.json', import.meta.url), 'utf8'),
) as { fixtures: Fixture[] };

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('T-GOLD envelope golden fixtures', () => {
  test('fixture file is non-empty', () => {
    expect(golden.fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of golden.fixtures) {
    test(`ENV-01/02 ${fx.name}: encode is byte-exact and decode round-trips`, () => {
      const payload = hexToBytes(fx.payloadHex);
      const encoded = encodeEnvelope({
        channel: fx.channel as Channel,
        systemType: fx.systemType,
        clientId: fx.clientId,
        payload,
      });
      expect(bytesToHex(encoded)).toBe(fx.hex);

      const decoded = decodeEnvelope(hexToBytes(fx.hex));
      expect(decoded.channel).toBe(fx.channel);
      expect(decoded.systemType).toBe(fx.channel === Channel.System ? fx.systemType : 0);
      expect(decoded.clientId).toBe(fx.clientId);
      expect(bytesToHex(decoded.payload)).toBe(fx.payloadHex);
    });
  }
});
