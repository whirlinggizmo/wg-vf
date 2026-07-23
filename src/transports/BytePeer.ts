// One transport attachment, as seen by the host's peer registry (Part II §5).
// This is the existing byte-pipe seam (send / onBytes) multiplied per peer;
// attachPeer(clientId, pipe) supersedes the single setSendBytes sink.

export interface SendOptions {
  /**
   * The caller grants ownership of `bytes`: this send is the buffer's sole use,
   * so the transport MAY take it — transfer it across a worker boundary
   * (zero-copy, neutering the sender's view) or deliver it in-process without a
   * defensive copy — instead of cloning. Omit/false when the same buffer is
   * shared across sends (a broadcast to multiple peers), where taking it would
   * corrupt the other recipients. A transport is always free to ignore this and
   * copy. Delivered bytes are identical either way (enforced by the DET suite).
   */
  transferable?: boolean;
}

export interface BytePeer {
  /** Send raw bytes toward the peer. `opts.transferable` may grant ownership. */
  send(bytes: Uint8Array, opts?: SendOptions): void;
  /** Register a receiver for bytes arriving from the peer; returns an unsubscribe. */
  onBytes(cb: (bytes: Uint8Array) => void): () => void;
}
