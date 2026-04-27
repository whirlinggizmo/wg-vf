import { decodeEnvelope, SystemType, encodeInitPayload } from '../src';
import { decodeJsonPayload, encodeJsonPayload } from '../examples/common/codec';
import type { RemoteVignetteHost } from '../src';

export const TEST_WORKER_URL = new URL('../src/bridge/VignetteBridgeWorker.ts', import.meta.url);
export const TEST_VIGNETTE_URL = new URL('./fixtures/TestEchoVignette.ts', import.meta.url).href;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  fn: () => T | undefined,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const intervalMs = options?.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

export function pollOutboxJson(bridge: { pollOutbox(): Uint8Array[] }): unknown[] {
  return bridge.pollOutbox().map((payload) => decodeJsonPayload(payload));
}

export function encodeInit(userId: string): Uint8Array {
  return encodeJsonPayload({ userId });
}

export function encodeRemoteInit(userId: string): Uint8Array {
  return encodeInitPayload({
    vignetteType: 'js',
    vignetteUrl: TEST_VIGNETTE_URL,
    initPayload: encodeJsonPayload({ userId }),
  });
}

export function encodeMessage(type: string, extra: Record<string, unknown> = {}): Uint8Array {
  return encodeJsonPayload({ type, ...extra });
}

export function decodeEnvelopePayload(bytes: Uint8Array): unknown {
  return decodeJsonPayload(decodeEnvelope(bytes).payload);
}

type TestServer = {
  hostname: string;
  port: number;
  closeConnections(code?: number, reason?: string): void;
  stop(closeActiveConnections?: boolean): void;
};

export function startRemoteTestServer(
  createHost: () => RemoteVignetteHost,
  options?: {
    delayPongMs?: number;
  },
): TestServer {
  const hostname = '127.0.0.1';
  type ConnectionData = {
    host: RemoteVignetteHost;
    onBytes: ((bytes: Uint8Array) => void) | null;
  };
  const activeSockets = new Set<ServerWebSocket<ConnectionData>>();

  function toUint8Array(message: unknown): Uint8Array | null {
    if (message instanceof Uint8Array) {
      return message;
    }

    if (message instanceof ArrayBuffer) {
      return new Uint8Array(message);
    }

    if (ArrayBuffer.isView(message)) {
      return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    }

    return null;
  }

  const server = Bun.serve<ConnectionData>({
    port: 0,
    hostname,
    fetch(req, server) {
      const host = createHost();

      if (
        server.upgrade(req, {
          data: {
            host,
            onBytes: null,
          },
        })
      ) {
        return;
      }

      return new Response('Expected WebSocket', { status: 426 });
    },
    websocket: {
      open(ws) {
        activeSockets.add(ws);
        const data = ws.data;
        data.host.attachToPeer({
          send(bytes) {
            const envelope = decodeEnvelope(bytes);
            if (
              options?.delayPongMs &&
              envelope.systemType === SystemType.Pong
            ) {
              const copy = bytes.slice();
              setTimeout(() => {
                ws.send(copy);
              }, options.delayPongMs);
              return;
            }

            ws.send(bytes);
          },
          onBytes(cb) {
            data.onBytes = cb;
            return () => {
              if (data.onBytes === cb) {
                data.onBytes = null;
              }
            };
          },
        });
      },
      message(ws, message) {
        const data = ws.data;
        const bytes = toUint8Array(message);

        if (!bytes) {
          ws.close(1003, 'Binary frames required');
          return;
        }

        data.onBytes?.(bytes);
      },
      async close(ws) {
        activeSockets.delete(ws);
        const data = ws.data;
        data.onBytes = null;
        await data.host.onShutdown();
      },
    },
  });

  return {
    hostname,
    port: server.port,
    closeConnections(code = 1012, reason = 'test close') {
      for (const ws of activeSockets) {
        ws.close(code, reason);
      }
    },
    stop(closeActiveConnections?: boolean) {
      server.stop(closeActiveConnections);
    },
  };
}
