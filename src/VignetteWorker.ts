import { WorkerVignetteHost } from './hosts/WorkerVignetteHost';

const host = new WorkerVignetteHost({});
host.attachToWorker(self as DedicatedWorkerGlobalScope);
