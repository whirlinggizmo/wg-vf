// The multiplexing protocol between the socket thread (main) and the sim thread
// (worker). Many WebSocket connections share one Worker channel, tagged by a
// numeric connection id. The main thread does socket IO *and the envelope
// (de)serialization*, so the bridge carries structured envelopes and the worker's
// sim thread never touches the wire format — isolated from framing as well as
// from socket jitter and connection churn.

import type { Envelope } from '../src';

/** Main (sockets) → worker (sim). */
export type MainToWorker =
  | { t: 'open'; id: number; room: string } // a client connected to /r/<room>
  | { t: 'data'; id: number; env: Envelope } // a decoded envelope from that client
  | { t: 'close'; id: number }; // that client's socket closed

/** Worker (sim) → main (sockets). */
export type WorkerToMain =
  | { t: 'data'; id: number; env: Envelope } // an envelope to encode + send to that client
  | { t: 'close'; id: number; code?: number; reason?: string }; // close that client
