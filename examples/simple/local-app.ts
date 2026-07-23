// Single-player / local path: the host runs in a Web Worker, the app talks to
// it over a postMessage EnvelopePeer. Same envelope protocol as the remote app —
// only the transport differs, and locally the envelope crosses as a structured
// object (no byte framing).

import {
  messagePortEnvelopePeer,
  type MessagePortLike,
  Channel,
  SystemType,
  encodeInitPayload,
  decodeReadyPayload,
  decodeErrorPayload,
  readFrameHeader,
} from "../../src";

const MAX_FRAMES = Number(Bun.env.VF_FRAMES ?? 5);

const worker = new Worker(new URL("./local-worker.ts", import.meta.url).href, { type: "module" });
const peer = messagePortEnvelopePeer(worker as unknown as MessagePortLike);
console.log("[app] worker host spawned");

let frames = 0;

peer.onEnvelope((env) => {
  if (env.channel === Channel.System) {
    if (env.systemType === SystemType.Ready) {
      const r = decodeReadyPayload(env.payload)!;
      console.log(`[app] Ready: clientId=${r.clientId} vignette=${r.vignetteId}@${r.version} step=${r.fixedStepUs}us`);
      // A structured envelope — no framing; the payload buffer is transferred.
      peer.send(
        { channel: Channel.App, systemType: 0, clientId: 0, payload: new TextEncoder().encode("hello from app") },
        { transferable: true },
      );
      console.log("[app] sent App message");
    } else if (env.systemType === SystemType.Error) {
      console.log("[app] Error:", decodeErrorPayload(env.payload));
    }
    return;
  }

  if (env.channel === Channel.App) {
    console.log(`[app] echo: ${new TextDecoder().decode(env.payload)}`);
    return;
  }

  if (env.channel === Channel.Frame) {
    const fh = readFrameHeader(env.payload)!;
    const counter = new DataView(fh.body.buffer, fh.body.byteOffset).getUint32(4, true);
    console.log(`[app] frame seq=${fh.frameSeq} sourceTick=${fh.sourceTick} counter=${counter}`);
    if (++frames >= MAX_FRAMES) {
      console.log(`[app] received ${MAX_FRAMES} frames — done`);
      worker.terminate();
      process.exit(0);
    }
  }
});

// Provision by naming the vignette — a structured envelope over the port.
peer.send(
  {
    channel: Channel.System,
    systemType: SystemType.Init,
    clientId: 0,
    payload: encodeInitPayload({ vignetteId: "simple", initPayload: new TextEncoder().encode("{}") }),
  },
  { transferable: true },
);
console.log("[app] sent Init");
