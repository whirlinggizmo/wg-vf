# Vignette Filesystem ABI

One contract, every target. A vignette's storage behaves identically whether it
runs as **TS**, **wasm**, or **native**, because all three expose the *same*
operations against a **host-owned, jailed mount**. This document is the
normative spec; the TS face is `VignetteFs` in
[`src/storage/VignetteStorage.ts`](../src/storage/VignetteStorage.ts).

## Model

- The **host owns the backend.** The vignette never touches real IO — it calls
  the FS ABI, and the host services it. This is what makes wasm (sandboxed, no
  ambient IO) work the same as native.
- Each session gets a **mount**: a jailed, in-memory file tree keyed under a
  scope (`scopeFor(vignetteId, storageKey)`). The vignette works in a relative
  keyspace it cannot escape.
- **Reads/writes are synchronous.** Durability is a separate, async concern.
- **Restore is host-orchestrated, before `init`.** The host loads the scope's
  durable blob into the mount, then constructs and inits the vignette, so it
  rehydrates synchronously. There is **no** synchronous durable read from a
  vignette (it would be impossible on TS-in-worker and unsafe for determinism).
- **`flush()` is a durability barrier**, not a data transfer: "make prior writes
  durable." A backend that is already durable (native fs) or has none (memory /
  no store) treats it as a **no-op**.

## Operations

| Op | Semantics |
|---|---|
| `read(path) → bytes \| null` | File contents, or null if absent. |
| `write(path, bytes)` | Create/replace a file; auto-creates parent dirs (`mkdir -p`). Copies bytes. |
| `delete(path) → bool` | Remove a file; true if one was removed. |
| `exists(path) → bool` | True for a file **or** directory. `""` (root) always exists. |
| `isDirectory(path) → bool` | True for an explicit (`mkdir`) or implied (has children) directory. |
| `mkdir(path)` | Create a directory and all missing parents (`mkdir -p`). Idempotent. |
| `list(prefix?) → string[]` | File keys at/under `prefix` (default all), sorted. |
| `flush() → Promise` | Durability barrier (async). No-op where already durable. |

## Jail

Every path is normalized and confined to the mount root — the host enforces
this, so no target can bypass it:

- Separators unified (`\` → `/`); leading slashes stripped (root-relative).
- `.` / empty segments collapse; interior `..` that stays inside is fine.
- **Rejected:** a `..` that rises above the root, an absolute drive path
  (`C:/…`), or a NUL byte. TS throws `StorageJailError`; the C ABI returns the
  jail error code.

## C / wasm / native ABI

The C targets expose the same operations as **host imports** (the host provides
them; the vignette calls them — the host keeps the single jailed mount). UTF-8
paths, explicit lengths, little-endian. Return codes: `>= 0` success (or a byte
count); negative is an error:

```
-1  not found / no data
-2  buffer too small (call wg_vf_fs_size first)
-3  jail violation (path escaped the mount)
-4  invalid arguments
```

```c
/* Imports the host supplies to a vignette module. */
int32_t wg_vf_fs_size  (const char *path, uint32_t path_len);                                 /* size, or -1 */
int32_t wg_vf_fs_read  (const char *path, uint32_t path_len, uint8_t *out, uint32_t out_cap); /* bytes copied */
int32_t wg_vf_fs_write (const char *path, uint32_t path_len, const uint8_t *data, uint32_t data_len);
int32_t wg_vf_fs_delete(const char *path, uint32_t path_len);                                 /* 1 / 0 */
int32_t wg_vf_fs_exists(const char *path, uint32_t path_len);                                 /* 1 / 0 */
int32_t wg_vf_fs_is_dir(const char *path, uint32_t path_len);                                 /* 1 / 0 */
int32_t wg_vf_fs_mkdir (const char *path, uint32_t path_len);
int32_t wg_vf_fs_list  (const char *prefix, uint32_t prefix_len, uint8_t *out, uint32_t out_cap); /* NUL-separated keys */
void    wg_vf_fs_flush (void);  /* durability barrier; host performs it async, fire-and-forget */
```

`read` negotiates size: call `wg_vf_fs_size`, allocate, then `wg_vf_fs_read`.
`list` writes NUL-separated keys into the buffer and returns the total byte
length (which may exceed `out_cap`, signalling "call again with a bigger
buffer"). Introducing these imports is what takes `WG_VF_ABI_VERSION` to **2** —
a module that uses them requires a host that provides them.

## Relationship to wg-utils

This is the JS-side counterpart to `wgutils-c/fileio` (mount root = jail,
sync ops + async flush/restore). They share this spec; the C ABI above is
deliberately close to `fileio`'s surface so a native host can back the imports
with `wgutils-c/fileio` directly. The module is written to be extractable — it
has no wg-vf coupling — so it can graduate to a standalone package aligned with
wg-utils when there's a reason to.

## Non-goals

- No synchronous durable reads (see Model). Restore covers load-at-start; `fs`
  reads only ever hit the in-memory mount.
- No mid-`fixedTick` async. Writes are fire-and-forget; `flush()` is called at
  the vignette's cadence or in `shutdown()`, never awaited inside a step —
  keeping the deterministic core deterministic.
- A future `fetch(url → path)` capability (assets) will land as a separate
  service, modeled as fetch-to-file so it stays JSPI-free.
