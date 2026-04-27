# Vignette Runtime ABI

This document defines the host-to-vignette runtime contract independently of
the current TypeScript API.

The intent is to make the vignette runtime hostable by multiple shells:

- browser worker hosts
- browser remote hosts
- native desktop executables
- headless server processes

The current codebase already implements part of this ABI through the WASM
runtime path. This document promotes that contract into an explicit host-neutral
interface.

## Goals

- Make the host/vignette contract independent of TypeScript classes.
- Treat JS/TS as one host implementation, not the canonical runtime.
- Preserve host ownership of lifecycle and simulation pumping.
- Support both local in-process hosts and remote/networked hosts.
- Leave room for future shared-memory and native-host implementations.

## Non-Goals

- This document does not define the bridge-to-worker API.
- This document does not define the app-to-host envelope format.
- This document does not require every host to use the same transport.

## Terms

- `Host`: the shell that loads and drives a vignette runtime.
- `Vignette`: the runtime payload being hosted.
- `ABI`: the binary/runtime contract between host and vignette.
- `Bridge`: app-facing session API. Not part of the ABI itself.

## Core Ownership Model

The host owns:

- runtime loading
- initialization
- `tick`
- `fixed_tick`
- message ingress
- outbox draining
- shutdown
- error handling and lifecycle policy

The vignette owns:

- internal simulation state
- consumption of input payloads
- production of output payloads

The host pumps the vignette. The vignette does not own its own scheduler.

## Canonical Entry Points

These exports are the current canonical lifecycle entry points:

- `vf_init(in_ptr: u32, in_len: u32) -> u32`
- `vf_tick(dt_us: u32, frame_id: u32) -> u32`
- `vf_fixed_tick(step_us: u32, step_index: u32) -> u32`
- `vf_handle_message(in_ptr: u32, in_len: u32) -> u32`
- `vf_shutdown() -> u32`

Current behavior:

- return value `0` means success
- non-zero return values indicate failure
- the host is responsible for interpreting non-zero as a host-side error

These entry points are already exported by the current WASM vignette build in
[examples/vignettes/echo-wasm/src/vignette_shared.nim](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/examples/vignettes/echo-wasm/src/vignette_shared.nim:117).

## Current Data Exchange Model

The current ABI is hybrid:

- control ingress is function-call based
- payload ingress is pointer-and-length based
- payload egress is ring-buffer based

This is the host-neutral contract that exists today.

### Input Payloads

For `vf_init` and `vf_handle_message`, the host supplies:

- `in_ptr`: offset/pointer to input bytes
- `in_len`: byte length of input payload

Payload bytes are opaque to the ABI. Their encoding is chosen by the host/app.

### Output Payloads

The vignette writes outgoing payloads into an outbox ring located in runtime
memory. The host drains that ring after lifecycle calls.

The current outbox layout is:

- `head: u32` at offset `0`
- `tail: u32` at offset `4`
- `capacity: u32` at offset `8`
- payload ring bytes start at offset `12`

Each queued payload is encoded as:

- `len: u32` little-endian
- `payload[len]`

The host reads from `head` until `head == tail`, and after consuming each
message it writes the new `head` value back into the ring header.

This layout is implemented in:

- [examples/vignettes/echo-wasm/src/vignette_shared.nim](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/examples/vignettes/echo-wasm/src/vignette_shared.nim:1)
- [src/vignettes/WasmVignette.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/vignettes/WasmVignette.ts:181)

## Required and Optional Exports

### Required

- `vf_init`
- `vf_tick`
- `vf_fixed_tick`
- `vf_handle_message`
- `vf_shutdown`
- `vf_outbox_offset`

### Optional

- `vf_outbox_capacity`
- `vf_inbox_staging_offset`
- `vf_inbox_staging_capacity`
- `vf_mem_alloc`
- `vf_mem_free`

The host must probe optional exports at runtime.

## Outbox Discovery

The host discovers the outbox region through:

- `vf_outbox_offset() -> u32`

Optionally:

- `vf_outbox_capacity() -> u32`

Current host behavior assumes the memory at `vf_outbox_offset()` begins with the
three-word header described above.

## Input Staging

Hosts need one of the following input strategies:

### Allocator-based staging

If the vignette exports:

- `vf_mem_alloc(size: u32) -> u32`
- `vf_mem_free(ptr: u32)`

Then the host may:

1. allocate runtime memory
2. copy payload bytes into that memory
3. call `vf_init` or `vf_handle_message`
4. free the temporary allocation

### Fixed staging region

If the vignette exports:

- `vf_inbox_staging_offset() -> u32`
- `vf_inbox_staging_capacity() -> u32`

Then the host may copy the payload into that fixed region before calling the
entry point.

Current TypeScript host behavior prefers allocator-based staging and falls back
to a fixed staging region if present. See
[src/vignettes/WasmVignette.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/vignettes/WasmVignette.ts:118).

## Return Codes

Current convention:

- `0` = success
- non-zero = failure

The ABI does not yet define a full error-code registry. For now:

- hosts should treat any non-zero code as a runtime failure
- hosts may surface the numeric code for debugging

Future refinement:

- reserve ranges for host errors versus vignette logic errors
- define stable symbolic meanings for common codes

## Memory and Encoding Rules

- Integer fields are little-endian unless otherwise stated.
- Payload bytes are opaque to the ABI.
- Hosts must not assume payload contents are JSON.
- Hosts must treat returned offsets as runtime-memory-relative addresses.

For browser-hosted WASM, these addresses are offsets into linear memory. For a
native shared-library host, the same conceptual contract may be mapped onto real
pointers instead of WASM offsets.

## Threading and Scheduling

The ABI does not require the vignette to manage its own thread or timing loop.

Instead:

- the host chooses when to call `vf_tick`
- the host chooses when to call `vf_fixed_tick`
- the host decides when to deliver input payloads
- the host decides when to shut the vignette down

This is important for symmetry:

- local hosts pump local vignettes
- remote hosts pump remote vignettes
- bridge/session layers coordinate, but do not own simulation ticking

## Host Shapes Supported by This ABI

This ABI is intended to support:

### Browser local host

- worker loads JS or WASM vignette
- host calls exported entry points
- host drains outbox bytes

### Browser remote host

- remote server host owns the vignette and pump
- client host talks to that remote host over transport
- host/vignette ABI still applies on the server side

### Native executable host

- executable loads shared library, WASM runtime, or equivalent runtime payload
- executable resolves known exports
- executable pumps lifecycle calls and drains output

## Relationship to the Current TypeScript Interface

The current TypeScript `Vignette` interface is an adapter-friendly API:

- `init(initPayload)`
- `tick(dtUs, frameId)`
- `fixedTick(stepUs, stepIndex)`
- `handleMessage(payload)`
- `shutdown()`
- `outboxHasMessages()`
- `outboxPop()`

That interface is useful, but it should be viewed as one host-side adaptation of
the lower-level runtime ABI, not the only valid runtime contract.

## Future Direction: Shared-Memory ABI

The current ABI is sufficient for the existing WASM host path, but a future
revision may standardize a more explicit shared-memory design.

A likely direction is three buffers:

- input buffer: host/app -> vignette
- output or event buffer: vignette -> host/app
- swap/state buffer: snapshot exchange with atomic sequence/version header

If adopted, that would be a new ABI revision, not an implicit replacement of the
current export-and-ring model.

If this evolves, the design should keep these rules:

- host still owns pumping and lifecycle
- buffer roles stay explicit
- control/status headers stay versioned
- local shared-memory optimizations do not leak into remote transport semantics

## Versioning

The runtime ABI should be explicitly versioned before native hosts depend on it.

Recommended next step:

- add `vf_abi_version() -> u32`

Suggested initial value:

- `1` for the current export-plus-outbox-ring ABI

## Practical Guidance

When implementing a new host:

1. Load the vignette runtime payload.
2. Resolve required exports.
3. Resolve optional staging and memory helper exports.
4. Discover the outbox region.
5. Call `vf_init`.
6. Pump `vf_tick` and `vf_fixed_tick` according to host policy.
7. Deliver app messages with `vf_handle_message`.
8. Drain the outbox ring after each call that may emit output.
9. Treat non-zero return codes as runtime failures.
10. Call `vf_shutdown` before unloading.

## Current Code References

- [src/vignettes/Vignette.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/vignettes/Vignette.ts:22)
- [src/vignettes/WasmVignette.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/vignettes/WasmVignette.ts:1)
- [src/hosts/LocalVignetteHost.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/hosts/LocalVignetteHost.ts:18)
- [src/hosts/RemoteVignetteHost.ts](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/src/hosts/RemoteVignetteHost.ts:30)
- [examples/vignettes/echo-wasm/src/vignette_shared.nim](/home/rknopf/projects/whirlinggizmo/packages/wg-vf/examples/vignettes/echo-wasm/src/vignette_shared.nim:1)
