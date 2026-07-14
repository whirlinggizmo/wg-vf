import type { Transport } from './Transport.js';

export class WebSocketTransport implements Transport {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private bytesListeners = new Set<(bytes: Uint8Array) => void>();
  private errorListeners = new Set<(err: Error) => void>();

  constructor(url: string) {
    this.url = url;
  }

  async open(): Promise<void> {
    if (this.socket) {
      throw new Error('WebSocket already open');
    }

    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
    });

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(event.data);
      for (const listener of this.bytesListeners) {
        listener(bytes);
      }
    };

    ws.onerror = () => {
      this.notifyError(new Error('WebSocket transport error'));
    };

    ws.onclose = (event: CloseEvent) => {
      const reason = event.reason ? `: ${event.reason}` : '';
      this.notifyError(new Error(`WebSocket closed (${event.code})${reason}`));
    };

    this.socket = ws;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  send(bytes: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    this.socket.send(bytes);
  }

  onBytes(cb: (bytes: Uint8Array) => void): () => void {
    this.bytesListeners.add(cb);
    return () => this.bytesListeners.delete(cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  private notifyError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}
