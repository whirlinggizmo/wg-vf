// T-SCRIPT building block (test plan §0): a test peer wrapping one BytePeer
// end. Sends the session verbs and records every envelope it receives, with
// typed accessors for the common queries. Transport-agnostic — works over any
// BytePeer (loopback today, a real socket adapter later).

import type { BytePeer } from '../transports/BytePeer.js';
import {
  Channel,
  SystemType,
  decodeEnvelope,
  encodeAppEnvelope,
  encodeSystemEnvelope,
  type Envelope,
} from '../envelope/index.js';
import {
  decodeErrorPayload,
  decodePingPayload,
  decodeReadyPayload,
  encodeInitPayload,
  encodeJoinPayload,
  encodePingPayload,
  type ErrorPayload,
  type PingPayload,
  type ReadyPayload,
} from '../envelope/systemPayloads.js';

export class HostPeer {
  readonly received: Envelope[] = [];

  constructor(private readonly end: BytePeer) {
    end.onBytes((bytes) => this.received.push(decodeEnvelope(bytes)));
  }

  init(vignetteId: string, initPayload: Uint8Array = new Uint8Array()): void {
    this.end.send(encodeSystemEnvelope(SystemType.Init, encodeInitPayload({ vignetteId, initPayload })));
  }

  join(vignetteId: string, resumeToken?: Uint8Array): void {
    this.end.send(encodeSystemEnvelope(SystemType.Join, encodeJoinPayload({ vignetteId, resumeToken })));
  }

  /** Send an App message. `forgedClientId` proves the host stamps identity. */
  app(payload: Uint8Array, forgedClientId = 0): void {
    this.end.send(encodeAppEnvelope(payload, forgedClientId));
  }

  leave(): void {
    this.end.send(encodeSystemEnvelope(SystemType.Leave));
  }

  shutdown(): void {
    this.end.send(encodeSystemEnvelope(SystemType.Shutdown));
  }

  ping(sequence: number, sentAtMs: number): void {
    this.end.send(encodeSystemEnvelope(SystemType.Ping, encodePingPayload({ sequence, sentAtMs })));
  }

  ready(): ReadyPayload | null {
    const env = this.system(SystemType.Ready).at(-1);
    return env ? decodeReadyPayload(env.payload) : null;
  }

  errors(): ErrorPayload[] {
    return this.system(SystemType.Error)
      .map((e) => decodeErrorPayload(e.payload))
      .filter((p): p is ErrorPayload => p !== null);
  }

  pong(): PingPayload | null {
    const env = this.system(SystemType.Pong).at(-1);
    return env ? decodePingPayload(env.payload) : null;
  }

  apps(): Envelope[] {
    return this.received.filter((e) => e.channel === Channel.App);
  }

  frames(): Envelope[] {
    return this.received.filter((e) => e.channel === Channel.Frame);
  }

  shutdowns(): Envelope[] {
    return this.system(SystemType.Shutdown);
  }

  private system(type: SystemType): Envelope[] {
    return this.received.filter((e) => e.channel === Channel.System && e.systemType === type);
  }
}
