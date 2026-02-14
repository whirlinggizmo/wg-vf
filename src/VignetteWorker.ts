import { WorkerVignetteHost } from './hosts/WorkerVignetteHost';
import { isVignetteType, type VignetteType } from './VignetteTypes';

type WorkerConfigMessage = {
  type: 'vf-config';
  vignetteType: VignetteType;
  vignetteUrl: string;
};

type WorkerMessage = WorkerConfigMessage | unknown;

function isWorkerConfigMessage(msg: unknown): msg is WorkerConfigMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  const candidate = msg as Partial<WorkerConfigMessage>;
  return (
    candidate.type === 'vf-config' &&
    isVignetteType(candidate.vignetteType) &&
    typeof candidate.vignetteUrl === 'string'
  );
}

function createHost(msg: WorkerConfigMessage): WorkerVignetteHost {
  return new WorkerVignetteHost({
    vignetteType: msg.vignetteType,
    vignetteModuleUrl: msg.vignetteUrl,
  });
}

let configured = false;

(self as DedicatedWorkerGlobalScope).onmessage = (event: MessageEvent<WorkerMessage>) => {
  if (configured) {
    return;
  }

  const msg = event.data;
  if (isWorkerConfigMessage(msg)) {
    configured = true;
    const host = createHost(msg);
    host.attachToWorker(self as DedicatedWorkerGlobalScope);
  }
};
