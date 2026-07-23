# Transport performance: copies, and how to remove them

## Threading: isolate the sim from IO

The authoritative-server shape is *sim in its own thread, network IO outside it*,
so socket jitter and connection churn can't stall the fixed-step loop. wg-vf's
`BytePeer` seam is the cut line between the two.

- **Browser**: `runWorkerHost` already puts the host + sim in a **Worker**; the
  app + its transport run on the main (render) thread.
- **Server**: the reference `remote-server.ts` runs the sockets on the main
  thread and the **SessionManager + hosts + sims + pump in a Worker**
  (`remote-server-worker.ts`), multiplexing every connection over the one Worker
  channel by a numeric id (`remote-server-bridge.ts`). The main thread only
  shuttles raw bytes; it never touches the envelope. So both topologies share the
  shape: **sim in a worker, IO on the "main" thread** (render for browser,
  sockets for server).

And serialization is off the sim thread too: the host works in structured
`Envelope`s (the `EnvelopePeer` seam), and byte (de)serialization is a transport
concern (`byteEnvelopePeer`) that runs wherever the transport runs. In the
server, the **main thread decodes inbound socket bytes and encodes outbound**;
the bridge carries structured envelopes; the worker's `SessionManager.connectEnvelopes`
hands the host envelopes directly — so the sim thread never touches the wire
format. `VignetteHost.connect(bytePeer)` still wraps with `byteEnvelopePeer` for
the in-thread case (browser worker, tests), so where framing runs is just "which
side wraps."


The byte path copies payloads at a few points. This documents what's done, what's
deliberately deferred, and the design of the advanced versions — so the next step
is a decision, not a rediscovery.

## The copy map (per message)

**Egress** (vignette emits → peer): (1) `encode*Envelope` frames header+payload
into a fresh buffer — **copy**; (2) `pipe.send` — a worker `postMessage`
structured-clones, loopback historically `slice()`d, WebSocket copies into the
socket buffer. **Ingress**: (3) transport receive `new Uint8Array(event.data)` —
**copy**; (4) `decodeEnvelope` slices the payload out — **copy**; (5) wasm only:
staging the payload into linear memory — **copy**.

## Done: the ownership hint (transport-local, DET-guarded)

`BytePeer.send(bytes, { transferable })`. The host grants ownership only when the
send is the buffer's **sole use** — `PeerRegistry.route` sets `transferable: true`
for a unicast, and for a broadcast **only when there's exactly one recipient**
(the single-player worker path). A shared broadcast buffer is never granted, so
taking it can't corrupt the other peers.

Transports MAY act on the grant:
- **Worker** (`messagePortBytePeer`): `postMessage(bytes, [bytes.buffer])` —
  zero-copy transfer instead of a structured-clone copy. Only when the view owns
  its whole buffer (else the transfer would neuter unrelated bytes → falls back to
  copy). This is the real win: a 64 KB frame per tick no longer clones.
- **Loopback**: delivers as-is instead of a defensive `slice()`.

Delivered bytes are identical whether a transport copies or takes the buffer — the
determinism suite enforces that, which is why this is safe to ship without a
contract freeze. A transport is always free to ignore the hint and copy.

**Why it's worth it: a clone allocates on the receiver.** A structured clone
doesn't just copy — it allocates a fresh buffer on the receiving side and copies
into it. A transfer *moves* the existing buffer: no receiver allocation, no copy.
So the grant saves work on **both** sides for a sole recipient. It's also why it
can't help a broadcast to N: `N` clones = 0 host-allocs + `N` receiver-allocs +
`N` copies, while copy-per-recipient + transfer = `N` host-allocs + 0
receiver-allocs + `N` copies — the same totals, just shifted sides. So the grant
is (correctly) restricted to a sole recipient.

**Both directions.** Egress (host → peer) is granted automatically by `route`.
Ingress (app → sim) is the *client's* `send` to grant — and it's the cleanest
case: a client is always the sole sender and the host the sole recipient, so a
client send is always transfer-safe when it owns the buffer (a freshly encoded
envelope always does). `messagePortBytePeer` honors the hint either way; a client
opts in by passing `{ transferable: true }`. (Only the worker path benefits — a
WebSocket `send` can't transfer, so the hint is a no-op there. And ingress still
pays the `decodeEnvelope` slice + any wasm staging, so it removes one of two
ingress copies, not all.)

## Deferred #1: buffer pooling / return-swap

Transfer removes the *copy* but the sender loses the buffer, so each send now
*allocates* a fresh one. A return-swap scheme recycles buffers (ownership
ping-pongs: the receiver transfers a buffer back into the sender's pool), removing
that allocation too.

Why it's deferred, not just "more work":

- **It changes the `BytePeer` contract** to "you may not retain what you send;
  buffers round-trip." That's an ABI-level change to the seam, not a local tweak.
- **Lifetime hazard.** A buffer can only be returned once the receiver is fully
  done. If a vignette **retains a payload**, its buffer can never be returned —
  and the vignette ABI doesn't forbid retention.
- **Return-channel overhead.** Each frame needs a return `postMessage`; at 60 fps
  that's 60 extra messages/sec/direction, partially eating the savings.
- **Size bucketing.** Pooled buffers are fixed-size; larger messages need a bigger
  bucket + a fallback allocate.
- **1:1 only.** A transfer has a single new owner, so this works for the duplex
  single-player worker path but not broadcast-to-N (and not WebSocket at all).

Build it only if a benchmark shows **allocation** (not copy) is the bottleneck,
and ship it as an **opt-in pooled `BytePeer` variant** with an explicit
"must not retain payload" contract — never by complicating the core `send()`.

## Deferred #2: SharedArrayBuffer for the wasm boundary

The wasm staging copies (payload in, frame/outbox out) are **unavoidable without
shared memory** — transferables don't cross into wasm linear memory. A
`SharedArrayBuffer` shared between the host and the wasm instance could let both
read/write the same region, eliminating those copies.

Costs to weigh first: SAB requires **cross-origin isolation** (COOP/COEP headers)
and carries the Spectre-era security constraints; it's a real deployment burden
and a wider ABI (a shared-memory framing between host and sim). So it's the path
to wasm zero-copy, but only worth it for a genuinely copy-bound wasm workload.

## Deferred #3: eliminating the framing copy (egress step 1)

Removing the `encode` copy means the vignette emits *into* host-provided
pre-headered buffers, or `send` accepts a scatter-gather `[header, payload]`.
Either is an outbox/`emit` ABI change — defer until the contract is frozen.
