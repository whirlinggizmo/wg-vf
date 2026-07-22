// One transport attachment, as seen by the host's peer registry (Part II §5).
// This is the existing byte-pipe seam (send / onBytes) multiplied per peer;
// attachPeer(clientId, pipe) supersedes the single setSendBytes sink.

export interface BytePeer {
  /** Send raw bytes toward the peer. */
  send(bytes: Uint8Array): void;
  /** Register a receiver for bytes arriving from the peer; returns an unsubscribe. */
  onBytes(cb: (bytes: Uint8Array) => void): () => void;
}
