// A lean v2 client: connect over a real WebSocket, provision the "simple"
// vignette, send an App message (to see the echo), and stream frames from the
// server-side sim until MAX_FRAMES, then exit. Verifies the framework end to
// end over a real socket (not the in-process loopback the tests use).

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import {
  WebSocketTransport,
  Channel,
  SystemType,
  encodeSystemEnvelope,
  encodeAppEnvelope,
  encodeJoinPayload,
  decodeEnvelope,
  decodeReadyPayload,
  decodeErrorPayload,
  readFrameHeader,
  ResumeCoordinator,
  memoryTokenStore,
  type TokenStore,
} from "../../src";

// A file-backed token store so running this client twice with the same
// VF_SESSION_FILE stands in for a browser page reload: the first run stores the
// resumeToken, the second reopens with a resume-Join and keeps its clientId
// (as long as the server's reconnect grace hasn't lapsed). In a browser, use
// webStorageTokenStore(key, sessionStorage) instead.
function fileTokenStore(path: string): TokenStore {
  return {
    load: () => {
      if (!existsSync(path)) return null;
      try {
        const { clientId, token } = JSON.parse(readFileSync(path, "utf8")) as { clientId: number; token: number[] };
        return { clientId, token: Uint8Array.from(token) };
      } catch {
        return null;
      }
    },
    save: (r) => writeFileSync(path, JSON.stringify({ clientId: r.clientId, token: Array.from(r.token) })),
    clear: () => existsSync(path) && rmSync(path),
  };
}

const base = Bun.env.VF_HOST_URL ?? "ws://localhost:8787";
const room = Bun.env.VF_ROOM ?? "demo";
const url = `${base}/r/${room}`;
const MAX_FRAMES = Number(Bun.env.VF_FRAMES ?? 5);
// VF_JOIN=1 attaches to an already-provisioned session (Join) instead of
// provisioning it (Init) — the multiplayer path.
const JOIN = Bun.env.VF_JOIN === "1";

const transport = new WebSocketTransport(url);
await transport.open();
console.log(`[app] connected to ${url}`);

// Resume state: file-backed when VF_SESSION_FILE is set (so a re-run resumes),
// else in-memory (fresh each run).
const store: TokenStore = Bun.env.VF_SESSION_FILE ? fileTokenStore(Bun.env.VF_SESSION_FILE) : memoryTokenStore();
const resume = new ResumeCoordinator("simple", store);

let frames = 0;

transport.onBytes((bytes) => {
  const env = decodeEnvelope(bytes);

  if (env.channel === Channel.System) {
    if (env.systemType === SystemType.Ready) {
      const r = decodeReadyPayload(env.payload)!;
      const { resumed } = resume.onReady(r); // persist the fresh token; detect resume
      console.log(
        `[app] Ready: clientId=${r.clientId} ${resumed ? "(resumed)" : "(fresh session)"} ` +
          `vignette=${r.vignetteId}@${r.version} step=${r.fixedStepUs}us`,
      );
      transport.send(encodeAppEnvelope(new TextEncoder().encode("hello from app")));
      console.log(`[app] sent App message`);
    } else if (env.systemType === SystemType.Error) {
      console.log(`[app] Error:`, decodeErrorPayload(env.payload));
      resume.reset(); // the session ended — drop the stale token
    } else if (env.systemType === SystemType.Shutdown) {
      console.log(`[app] server Shutdown`);
      resume.reset();
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
// vignette — never a URL. VF_JOIN forces a plain multiplayer Join; otherwise the
// ResumeCoordinator opens with a resume-Join when it holds a saved token, or a
// fresh Init when it doesn't.
if (JOIN) {
  transport.send(encodeSystemEnvelope(SystemType.Join, encodeJoinPayload({ vignetteId: "simple" })));
  console.log(`[app] sent Join (multiplayer)`);
} else {
  const resuming = store.load() !== null;
  transport.send(resume.opening(new TextEncoder().encode("{}")));
  console.log(resuming ? `[app] sent resume-Join (had a saved token)` : `[app] sent Init (fresh)`);
}
