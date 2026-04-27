import { describe, expect, test } from 'bun:test';

import { VignetteBridge } from '../../../src';
import {
  TEST_VIGNETTE_URL,
  TEST_WORKER_URL,
  encodeInit,
  encodeMessage,
  pollOutboxJson,
  waitFor,
} from '../../helpers';

describe('VignetteBridge local integration', () => {
  test('connects, initializes, exchanges messages, and disconnects', async () => {
    const bridge = new VignetteBridge(TEST_WORKER_URL);

    expect(bridge.isConnected()).toBe(false);

    await bridge.connect({
      mode: 'local',
      vignetteType: 'js',
      moduleUrl: TEST_VIGNETTE_URL,
    });

    expect(bridge.isConnected()).toBe(true);

    await bridge.init(encodeInit('LocalUser'));

    const initMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string };
        return value.type === 'init' ? message : undefined;
      });
    });
    expect(initMessage).toEqual({ type: 'init', userId: 'LocalUser' });

    await bridge.handleMessage(encodeMessage('SpawnPlayer', { count: 1 }));

    const echoMessage = await waitFor(() => {
      const messages = pollOutboxJson(bridge);
      return messages.find((message) => {
        const value = message as { type?: string };
        return value.type === 'echo' ? message : undefined;
      });
    });
    expect(echoMessage).toEqual({
      type: 'echo',
      payload: { type: 'SpawnPlayer', count: 1 },
    });

    const ping = await bridge.ping();
    expect(ping.rttMs).toBeGreaterThanOrEqual(0);

    await bridge.disconnect();
    expect(bridge.isConnected()).toBe(false);
  });
});
