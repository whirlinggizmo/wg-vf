import type { Transport } from './Transport';

export interface ReconnectingWebSocketTransportOptions {
  url: string;
  minDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  maxRetries?: number;
  maxQueuedMessages?: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ReconnectingWebSocketTransport implements Transport {
  private readonly url: string;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxRetries: number;
  private readonly maxQueuedMessages: number;

  private socket: WebSocket | null = null;
  private connectingPromise: Promise<void> | null = null;
  private reconnectLoopPromise: Promise<void> | null = null;
  private closed = false;
  private retryCount = 0;

  private bytesListeners = new Set<(bytes: Uint8Array) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private connectListeners = new Set<() => void>();
  private disconnectListeners = new Set<() => void>();
  private reconnectListeners = new Set<() => void>();
  private sendQueue: Uint8Array[] = [];
  private wasDisconnected = false;

  constructor(options: ReconnectingWebSocketTransportOptions) {
    this.url = options.url;
    this.minDelayMs = Math.max(1, options.minDelayMs ?? 250);
    this.maxDelayMs = Math.max(this.minDelayMs, options.maxDelayMs ?? 5_000);
    this.backoffMultiplier = Math.max(1, options.backoffMultiplier ?? 2);
    this.maxRetries = Math.max(0, options.maxRetries ?? Number.POSITIVE_INFINITY);
    this.maxQueuedMessages = Math.max(1, options.maxQueuedMessages ?? 128);
  }

  async open(): Promise<void> {
    this.closed = false;
    if (this.isOpen()) {
      return;
    }
    if (!this.connectingPromise) {
      this.connectingPromise = this.connectWithRetry();
    }
    await this.connectingPromise;
  }

  close(): void {
    this.closed = true;
    this.retryCount = 0;
    this.connectingPromise = null;
    this.reconnectLoopPromise = null;
    this.socket?.close();
    this.socket = null;
    this.sendQueue = [];
  }

  send(bytes: Uint8Array): void {
    if (this.closed) {
      throw new Error('WebSocket transport is closed');
    }

    if (this.isOpen()) {
      this.socket!.send(bytes);
      return;
    }

    if (this.sendQueue.length >= this.maxQueuedMessages) {
      this.sendQueue.shift();
    }
    // Copy to avoid caller-side mutation before flush.
    this.sendQueue.push(bytes.slice());
  }

  onBytes(cb: (bytes: Uint8Array) => void): () => void {
    this.bytesListeners.add(cb);
    return () => this.bytesListeners.delete(cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  onConnect(cb: () => void): () => void {
    this.connectListeners.add(cb);
    return () => this.connectListeners.delete(cb);
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  onReconnect(cb: () => void): () => void {
    this.reconnectListeners.add(cb);
    return () => this.reconnectListeners.delete(cb);
  }

  private async connectWithRetry(): Promise<void> {
    this.retryCount = 0;
    let lastError: Error | null = null;

    while (!this.closed) {
      try {
        await this.connectOnce();
        this.retryCount = 0;
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = new Error(`WebSocket connect failed: ${message}`);
      }

      if (this.retryCount >= this.maxRetries) {
        if (lastError) {
          this.notifyError(lastError);
        }
        this.connectingPromise = null;
        throw new Error(`WebSocket reconnect exceeded max retries (${this.maxRetries})`);
      }

      const waitMs = this.nextBackoffDelay();
      console.info(
        `[wg-vf] websocket reconnect attempt ${this.retryCount + 1} in ${waitMs}ms (${this.url})`,
      );
      this.retryCount += 1;
      await delay(waitMs);
    }

    this.connectingPromise = null;
    throw new Error('WebSocket transport closed');
  }

  private async connectOnce(): Promise<void> {
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
      // `onclose` drives reconnection. Avoid signaling transient errors to clients.
    };

    ws.onclose = () => {
      if (this.socket === ws) {
        this.socket = null;
      }
      if (!this.closed) {
        this.wasDisconnected = true;
        this.notifyDisconnect();
        this.ensureReconnectLoop();
      }
    };

    const recovered = this.wasDisconnected;
    this.wasDisconnected = false;
    this.socket = ws;
    this.connectingPromise = null;
    if (recovered) {
      this.notifyReconnect();
    } else {
      this.notifyConnect();
    }
    this.flushSendQueue();
  }

  private ensureReconnectLoop(): void {
    if (this.reconnectLoopPromise) {
      return;
    }
    this.reconnectLoopPromise = (async () => {
      try {
        await this.open();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notifyError(new Error(`WebSocket reconnect failed: ${message}`));
      } finally {
        this.reconnectLoopPromise = null;
      }
    })();
  }

  private flushSendQueue(): void {
    if (!this.isOpen()) {
      return;
    }
    for (const bytes of this.sendQueue) {
      this.socket!.send(bytes);
    }
    this.sendQueue = [];
  }

  private isOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  private nextBackoffDelay(): number {
    const exponential = this.minDelayMs * this.backoffMultiplier ** this.retryCount;
    return Math.min(this.maxDelayMs, Math.round(exponential));
  }

  private notifyError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }

  private notifyConnect(): void {
    for (const listener of this.connectListeners) {
      listener();
    }
  }

  private notifyDisconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }

  private notifyReconnect(): void {
    for (const listener of this.reconnectListeners) {
      listener();
    }
  }
}
