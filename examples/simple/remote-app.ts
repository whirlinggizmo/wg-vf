// A lean v2 client: connect over a real WebSocket, provision the "simple"
// vignette, send an App message (to see the echo), and stream frames from the
// server-side sim until MAX_FRAMES, then exit. Verifies the framework end to
// end over a real socket (not the in-process loopback the tests use).

import {
  WebSocketTransport,
  Channel,
  SystemType,
  encodeSystemEnvelope,
  encodeAppEnvelope,
  encodeInitPayload,
  encodeJoinPayload,
  decodeEnvelope,
  decodeReadyPayload,
  decodeErrorPayload,
  readFrameHeader,
} from "../../src";

const url = Bun.env.VF_HOST_URL ?? "ws://localhost:8787";
const MAX_FRAMES = Number(Bun.env.VF_FRAMES ?? 5);
// VF_JOIN=1 attaches to an already-provisioned session (Join) instead of
// provisioning it (Init) — the multiplayer path.
const JOIN = Bun.env.VF_JOIN === "1";

const transport = new WebSocketTransport(url);
await transport.open();
console.log(`[app] connected to ${url}`);

let frames = 0;

transport.onBytes((bytes) => {
  const env = decodeEnvelope(bytes);

  if (env.channel === Channel.System) {
    if (env.systemType === SystemType.Ready) {
      const r = decodeReadyPayload(env.payload)!;
      console.log(
        `[app] Ready: clientId=${r.clientId} vignette=${r.vignetteId}@${r.version} step=${r.fixedStepUs}us`,
      );
      transport.send(encodeAppEnvelope(new TextEncoder().encode("hello from app")));
      console.log(`[app] sent App message`);
    } else if (env.systemType === SystemType.Error) {
      console.log(`[app] Error:`, decodeErrorPayload(env.payload));
    } else if (env.systemType === SystemType.Shutdown) {
      console.log(`[app] server Shutdown`);
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
      transport.close();
      process.exit(0);
    }
  }
});

// Provision (Init) or attach to an existing session (Join) by naming the
// vignette — never a URL.
if (JOIN) {
  transport.send(encodeSystemEnvelope(SystemType.Join, encodeJoinPayload({ vignetteId: "simple" })));
  console.log(`[app] sent Join`);
} else {
  transport.send(
    encodeSystemEnvelope(
      SystemType.Init,
      encodeInitPayload({ vignetteId: "simple", initPayload: new TextEncoder().encode("{}") }),
    ),
  );
  console.log(`[app] sent Init`);
}
