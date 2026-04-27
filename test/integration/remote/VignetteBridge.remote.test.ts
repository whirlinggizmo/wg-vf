import { afterEach, describe, expect, test } from 'bun:test';

import { RemoteVignetteHost, VignetteBridge } from '../../../src';
import {
  TEST_WORKER_URL,
  encodeMessage,
  encodeRemoteInit,
  pollOutboxJson,
  startRemoteTestServer,
  waitFor,
} from '../../helpers';

type RemoteServer = ReturnType<typeof startRemoteTestServer>;

describe('VignetteBridge remote integration', () => {
  let server: RemoteServer | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
  });

  test('connects, initializes, exchanges messages, pings, and disconnects', async () => {
    server = startRemoteTestServer(() => new RemoteVignetteHost({}));
    const bridge = new VignetteBridge(TEST_WORKER_URL);

    expect(bridge.isConnected()).toBe(false);

    await bridge.connect({
      mode: 'remote',
      remoteUrl: `ws://${server.hostname}:${server.port}`,
    });

    expect(bridge.isConnected()).toBe(false);

    await bridge.init(encodeRemoteInit('RemoteUser'));

    await waitFor(() => (bridge.isConnected() ? true : undefined));
    expect(bridge.isConnected()).toBe(true);

    const initMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string };
        return value.type === 'init' ? message : undefined;
      });
    });
    expect(initMessage).toEqual({ type: 'init', userId: 'RemoteUser' });

    await bridge.handleMessage(encodeMessage('SpawnPlayer', { count: 2 }));

    const echoMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string };
        return value.type === 'echo' ? message : undefined;
      });
    });
    expect(echoMessage).toEqual({
      type: 'echo',
      payload: { type: 'SpawnPlayer', count: 2 },
    });

    const ping = await bridge.ping();
    expect(ping.rttMs).toBeGreaterThanOrEqual(0);

    await bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
  });

  test('reconnects after the socket is dropped and resumes message flow', async () => {
    server = startRemoteTestServer(() => new RemoteVignetteHost({}));
    const bridge = new VignetteBridge(TEST_WORKER_URL);

    await bridge.connect({
      mode: 'remote',
      remoteUrl: `ws://${server.hostname}:${server.port}`,
    });

    await bridge.init(encodeRemoteInit('ReconnectUser'));
    await waitFor(() => (bridge.isConnected() ? true : undefined));

    pollOutboxJson(bridge);

    server.closeConnections();

    await waitFor(() => (bridge.isConnected() ? true : undefined), { timeoutMs: 5_000 });
    expect(bridge.isConnected()).toBe(true);

    const reinitMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string; userId?: string };
        return value.type === 'init' && value.userId === 'ReconnectUser' ? message : undefined;
      });
    }, { timeoutMs: 5_000 });
    expect(reinitMessage).toEqual({ type: 'init', userId: 'ReconnectUser' });

    await bridge.handleMessage(encodeMessage('AfterReconnect', { ok: true }));

    const echoMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string };
        return value.type === 'echo' ? message : undefined;
      });
    });
    expect(echoMessage).toEqual({
      type: 'echo',
      payload: { type: 'AfterReconnect', ok: true },
    });

    await bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
  });

  test('rejects an in-flight ping when disconnect happens before pong returns', async () => {
    server = startRemoteTestServer(() => new RemoteVignetteHost({}), {
      delayPongMs: 250,
    });
    const bridge = new VignetteBridge(TEST_WORKER_URL);

    await bridge.connect({
      mode: 'remote',
      remoteUrl: `ws://${server.hostname}:${server.port}`,
    });

    await bridge.init(encodeRemoteInit('PingRaceUser'));
    await waitFor(() => (bridge.isConnected() ? true : undefined));

    const pingPromise = bridge.ping();
    await bridge.disconnect();

    await expect(pingPromise).rejects.toThrow('Vignette bridge disconnected');
    expect(bridge.isConnected()).toBe(false);
  });
});
