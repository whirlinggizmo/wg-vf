import { afterEach, describe, expect, test } from 'bun:test';

import { LocalVignetteHost, decodeEnvelope, MessageKind } from '../../../src';
import { decodeJsonPayload, encodeJsonPayload } from '../../codec';
import { waitFor } from '../../helpers';

type Entity = {
  id: string;
  x: number;
  y: number;
  z: number;
  type: 'cube' | 'sphere';
  color: number;
};

type AppMessage =
  | { type: 'EntitySpawned'; entity: Entity }
  | { type: 'StateUpdate'; entities: Entity[] }
  | { type: string };

const THREE_TS_VIGNETTE_URL = new URL(
  '../../../examples/three/vignette/ts/out/three-vignette.js',
  import.meta.url,
).href;

const THREE_WASM_VIGNETTE_URL = new URL(
  '../../../examples/three/vignette/nim/out/three-vignette_wasm.js',
  import.meta.url,
).href;

const activeHosts = new Set<LocalVignetteHost>();

afterEach(async () => {
  for (const host of activeHosts) {
    await host.onShutdown();
  }
  activeHosts.clear();
});

describe('Three example local vignette integration', () => {
  test('js vignette emits changing state updates over time', async () => {
    await expectAnimatedState({
      vignetteType: 'js',
      moduleUrl: THREE_TS_VIGNETTE_URL,
    });
  });

  test('wasm vignette emits changing state updates over time', async () => {
    await expectAnimatedState({
      vignetteType: 'wasm',
      moduleUrl: THREE_WASM_VIGNETTE_URL,
    });
  });
});

async function expectAnimatedState(options: {
  vignetteType: 'js' | 'wasm';
  moduleUrl: string;
}): Promise<void> {
  const emittedMessages: AppMessage[] = [];
  const host = new LocalVignetteHost({
    vignetteType: options.vignetteType,
    vignetteUrl: options.moduleUrl,
  });
  activeHosts.add(host);

  host.setSendBytes((bytes) => {
    const envelope = decodeEnvelope(bytes);
    if (envelope.messageKind !== MessageKind.App) {
      return;
    }

    emittedMessages.push(decodeJsonPayload(envelope.payload) as AppMessage);
  });

  await host.onInit(encodeJsonPayload({ type: 'Init', scene: 'three-demo' }));
  await host.onAppMessage(encodeJsonPayload({ type: 'SpawnPlayer' }));
  await host.onAppMessage(encodeJsonPayload({ type: 'SpawnRandomEntity' }));

  const firstStateUpdate = await waitFor(() => {
    return emittedMessages.find((message): message is Extract<AppMessage, { type: 'StateUpdate' }> => {
      return message.type === 'StateUpdate' && message.entities.length >= 2;
    });
  });

  const animatedEntity = findAnimatedEntity(firstStateUpdate.entities);
  expect(animatedEntity).toBeDefined();

  const laterStateUpdate = await waitFor(() => {
    const stateUpdates = emittedMessages.filter(
      (message): message is Extract<AppMessage, { type: 'StateUpdate' }> =>
        message.type === 'StateUpdate' && message.entities.length >= 2,
    );

    return stateUpdates.find((message) => {
      const entity = message.entities.find((candidate) => candidate.id === animatedEntity!.id);
      return entity !== undefined && Math.abs(entity.y - animatedEntity!.y) > 1e-4
        ? message
        : undefined;
    });
  }, {
    timeoutMs: 2_000,
    intervalMs: 20,
  });

  const movedEntity = laterStateUpdate.entities.find((entity) => entity.id === animatedEntity!.id);
  expect(movedEntity).toBeDefined();
  expect(Math.abs(movedEntity!.y - animatedEntity!.y)).toBeGreaterThan(1e-4);

  await host.onShutdown();
  activeHosts.delete(host);
}

function findAnimatedEntity(entities: Entity[]): Entity | undefined {
  return entities.find((entity) => entity.id.startsWith('entity-'));
}
