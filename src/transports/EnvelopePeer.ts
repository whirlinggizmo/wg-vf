// The host↔transport seam, in structured envelopes. The host works only in
// `Envelope`s; byte-serialization is a transport concern (byteEnvelopePeer),
// which can run wherever the transport runs — including a separate IO thread, so
// the sim thread never touches the wire format. See docs/transport-perf.md.

import {
  SystemType,
  decodeEnvelope,
  encodeEnvelope,
  encodeSystemEnvelope,
  encodeErrorPayload,
  errorCodeForDecodeReason,
  EnvelopeDecodeError,
  type Envelope,
} from '../envelope/index.js';
import type { BytePeer, SendOptions } from './BytePeer.js';

export interface EnvelopePeer {
  /** Send an envelope toward the peer. `opts.transferable` may grant ownership. */
  send(envelope: Envelope, opts?: SendOptions): void;
  /** Register a receiver for envelopes arriving from the peer; returns an unsubscribe. */
  onEnvelope(cb: (envelope: Envelope) => void): () => void;
}

/**
 * Wire adapter: serialize envelopes to bytes and back over a raw {@link BytePeer}.
 * Framing and wire-level rejection live here — the host stays in envelopes. A
 * malformed inbound frame is answered with an Error and dropped (Part I §1.6);
 * the decode payload cap is read live via `maxPayloadBytes` so a per-session
 * override applies. Wrapping a BytePeer with this runs (de)serialization on the
 * BytePeer's own thread; leaving the host on a structured EnvelopePeer (and
 * wrapping the socket elsewhere) runs it on that other thread instead.
 */
export function byteEnvelopePeer(pipe: BytePeer, maxPayloadBytes: () => number): EnvelopePeer {
  return {
    send: (envelope, opts) => pipe.send(encodeEnvelope(envelope), opts),
    onEnvelope: (cb) =>
      pipe.onBytes((bytes) => {
        let env: Envelope;
        try {
          env = decodeEnvelope(bytes, { maxPayloadBytes: maxPayloadBytes() });
        } catch (err) {
          if (err instanceof EnvelopeDecodeError) {
            pipe.send(
              encodeSystemEnvelope(
                SystemType.Error,
                encodeErrorPayload({ code: errorCodeForDecodeReason(err.reason), message: err.message }),
              ),
            );
            return;
          }
          throw err;
        }
        cb(env);
      }),
  };
}
