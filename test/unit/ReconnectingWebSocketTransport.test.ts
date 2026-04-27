import type { ServerWebSocket } from 'bun';
import { afterEach, describe, expect, test } from 'bun:test';

import { ReconnectingWebSocketTransport } from '../../src';
import { sleep, waitFor } from '../helpers';

type TestWsServer = {
  hostname: string;
  port: number;
  received: Uint8Array[];
  closeConnections(code?: number, reason?: string): void;
  sendToAll(message: string | Uint8Array): void;
  stop(closeActiveConnections?: boolean): void;
};

function startWsServer(): TestWsServer {
  type Data = Record<string, never>;
  const hostname = '127.0.0.1';
  const received: Uint8Array[] = [];
  const sockets = new Set<ServerWebSocket<Data>>();

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
    if (typeof message === 'string') {
      return new TextEncoder().encode(message);
    }
    return null;
  }

  const server = Bun.serve<Data>({
    hostname,
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req, { data: {} })) {
        return;
      }
      return new Response('Expected WebSocket', { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      message(_ws, message) {
        const bytes = toUint8Array(message);
        if (bytes) {
          received.push(bytes.slice());
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const port = server.port;
  if (!port) {
    throw new Error('Server failed to start on a port');
  }

  return {
    hostname,
    port,
    received,
    closeConnections(code = 1012, reason = 'test close') {
      for (const ws of sockets) {
        ws.close(code, reason);
      }
    },
    sendToAll(message) {
      for (const ws of sockets) {
        ws.send(message);
      }
    },
    stop(closeActiveConnections?: boolean) {
      server.stop(closeActiveConnections);
    },
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('ReconnectingWebSocketTransport', () => {
  let server: TestWsServer | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('flushes queued sends on open and trims to maxQueuedMessages', async () => {
    server = startWsServer();
    const transport = new ReconnectingWebSocketTransport({
      url: `ws://${server.hostname}:${server.port}`,
      maxQueuedMessages: 2,
    });

    transport.send(new TextEncoder().encode('one'));
    transport.send(new TextEncoder().encode('two'));
    transport.send(new TextEncoder().encode('three'));

    await transport.open();

    await waitFor(() => (server!.received.length >= 2 ? true : undefined));
    expect(server.received.map(decodeUtf8)).toEqual(['two', 'three']);

    const receivedBytes: Uint8Array[] = [];
    const unbind = transport.onBytes((bytes) => {
      receivedBytes.push(bytes.slice());
    });

    server.sendToAll('hello');
    await waitFor(() => (receivedBytes.length > 0 ? true : undefined));
    expect(receivedBytes.map(decodeUtf8)).toEqual(['hello']);

    unbind();
    transport.close();
  });

  test('emits disconnect/reconnect and flushes queued sends after reconnect', async () => {
    server = startWsServer();
    const transport = new ReconnectingWebSocketTransport({
      url: `ws://${server.hostname}:${server.port}`,
      minDelayMs: 10,
      maxDelayMs: 20,
    });

    let connectCount = 0;
    let disconnectCount = 0;
    let reconnectCount = 0;

    transport.onConnect(() => {
      connectCount += 1;
    });
    transport.onDisconnect(() => {
      disconnectCount += 1;
    });
    transport.onReconnect(() => {
      reconnectCount += 1;
    });

    await transport.open();
    expect(connectCount).toBe(1);

    transport.send(new TextEncoder().encode('before-drop'));
    await waitFor(() => (server!.received.length >= 1 ? true : undefined));
    expect(server.received.map(decodeUtf8)).toContain('before-drop');

    server.closeConnections();
    await waitFor(() => (disconnectCount === 1 ? true : undefined), {
      timeoutMs: 2_000,
    });

    transport.send(new TextEncoder().encode('during-reconnect'));

    await waitFor(() => (reconnectCount === 1 ? true : undefined), {
      timeoutMs: 2_000,
    });
    await waitFor(
      () =>
        server!.received.some((payload) => decodeUtf8(payload) === 'during-reconnect')
          ? true
          : undefined,
      { timeoutMs: 2_000 },
    );

    expect(reconnectCount).toBe(1);
    expect(disconnectCount).toBe(1);

    transport.close();
  });

  test('fails after maxRetries and notifies error listeners', async () => {
    const transport = new ReconnectingWebSocketTransport({
      url: 'ws://127.0.0.1:9',
      minDelayMs: 10,
      maxDelayMs: 10,
      maxRetries: 1,
    });

    const errors: string[] = [];
    transport.onError((err) => {
      errors.push(err.message);
    });

    await expect(transport.open()).rejects.toThrow('WebSocket reconnect exceeded max retries (1)');
    await waitFor(() => (errors.length > 0 ? true : undefined), { timeoutMs: 2_000 });
    expect(errors.some((message) => message.includes('WebSocket connect failed'))).toBe(true);

    transport.close();
    await sleep(20);
  });
});
