# TODO

## Additional Architecture Follow-ups

- Collapse the duplicated runtime logic in `LocalVignetteHost` and `RemoteVignetteHost` into a shared host core or base class, keeping only the byte-I/O attachment different.
- Tighten the boundary between `VignetteBridgeWorker` and `LocalVignetteHost` so the worker stays focused on session/RPC orchestration and the host stays focused on vignette lifecycle ownership.
- Decide whether `LocalVignetteHost` needs any public worker-attachment helper, or whether `setSendBytes(...)` plus worker-owned orchestration is the intended shape.
- Review local versus remote message-flow symmetry and decide where differences are intentional versus accidental.
- Add lifecycle and failure-path tests for init, shutdown, reconnect, outbox draining, and host error handling.

## Suggested Order

1. Extract a shared runtime core from `LocalVignetteHost` and `RemoteVignetteHost`.
2. Keep local host attachment APIs minimal and aligned with worker-owned orchestration.
3. Add lifecycle and failure-path tests before further abstraction work.
