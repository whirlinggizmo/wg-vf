# TODO

## Additional Architecture Follow-ups

- Keep the boundary between `VignetteBridgeWorker` and `LocalVignetteHost` clear so the worker stays focused on session/RPC orchestration and the host stays focused on vignette lifecycle ownership.
- Review local versus remote message-flow symmetry and decide where differences are intentional versus accidental.
- ~~Add lifecycle and failure-path tests for init, shutdown, reconnect, outbox draining, and host error handling.~~ ✅ Done
- Low priority: consider normalizing all system payloads to binary instead of keeping `Ready` and `Error` as JSON while `Ping`/`Pong` are binary.

## Suggested Order

1. ~~Add lifecycle and failure-path tests before further abstraction work.~~ ✅ Done
2. Review local versus remote message-flow symmetry and decide where differences are intentional.
3. Keep the worker/host boundary clear as new behavior is added.
