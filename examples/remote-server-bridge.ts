// The multiplexing protocol between the socket thread (main) and the sim thread
// (worker). Many WebSocket connections share one Worker channel, tagged by a
// numeric connection id. The main thread does socket IO only; the worker runs
// the SessionManager + hosts + sims (and the envelope decode), isolated from
// socket jitter and connection churn.

/** Main (sockets) → worker (sim). */
export type MainToWorker =
  | { t: 'open'; id: number; room: string } // a client connected to /r/<room>
  | { t: 'data'; id: number; bytes: Uint8Array } // bytes from that client
  | { t: 'close'; id: number }; // that client's socket closed

/** Worker (sim) → main (sockets). */
export type WorkerToMain =
  | { t: 'data'; id: number; bytes: Uint8Array } // bytes to send to that client
  | { t: 'close'; id: number; code?: number; reason?: string }; // close that client
