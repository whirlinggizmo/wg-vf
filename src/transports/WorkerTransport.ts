import type { Transport } from './Transport';

interface WorkerTransportOptions {
  worker: Worker;
}

export class WorkerTransport implements Transport {
  private readonly worker: Worker;
  private bytesListeners = new Set<(bytes: Uint8Array) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(options: WorkerTransportOptions) {
    this.worker = options.worker;
  }

  async open(): Promise<void> {
    this.worker.onmessage = (event: MessageEvent<ArrayBuffer | Uint8Array>) => {
      const data = event.data;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      for (const listener of this.bytesListeners) {
        listener(bytes);
      }
    };

    this.worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || 'Worker transport error');
      for (const listener of this.errorListeners) {
        listener(err);
      }
    };
  }

  close(): void {
    this.worker.terminate();
  }

  send(bytes: Uint8Array): void {
    this.worker.postMessage(bytes, [bytes.buffer]);
  }

  onBytes(cb: (bytes: Uint8Array) => void): () => void {
    this.bytesListeners.add(cb);
    return () => this.bytesListeners.delete(cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }
}
