// @whirlinggizmo/wg-vf/testing — conformance harness surface (test plan §0).
//
// Present today (Phase 0/1/2 slice):
//   - VirtualClock (T-CLOCK)
//   - createLoopbackPipe / LoopbackBytePipe (T-PIPE)
//
// Still to land (see docs/TODO.md): LossyPipe (T-LOSSY), reference vignettes
// echo/counter/chaos (T-VIG-*), the script runner (T-SCRIPT), golden fixtures
// (T-GOLD), and runHostConformance() — the last needs the v2 host (Phase 4).

export { VirtualClock } from './VirtualClock.js';
export {
  createLoopbackPipe,
  type LoopbackPipe,
  type LoopbackOptions,
} from './LoopbackBytePipe.js';
export {
  EchoVignette,
  CounterVignette,
  ChaosVignette,
  ChaosOp,
  COUNTER_FRAME_SIZE,
} from './vignettes.js';
export { HostPeer } from './HostPeer.js';
export {
  hostConformanceCases,
  type ConformanceHost,
  type ConformanceCase,
  type MakeHost,
} from './conformance.js';
export type { BytePeer } from '../transports/BytePeer.js';
export type { Clock } from '../hosts/Clock.js';
