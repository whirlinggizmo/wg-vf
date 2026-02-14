export interface Transport {
  open(): Promise<void>;
  close(): void;
  send(bytes: Uint8Array): void;
  onBytes(cb: (bytes: Uint8Array) => void): () => void;
  onError?(cb: (err: Error) => void): () => void;
  onConnect?(cb: () => void): () => void;
  onDisconnect?(cb: () => void): () => void;
  onReconnect?(cb: () => void): () => void;
}
