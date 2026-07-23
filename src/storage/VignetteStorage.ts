// Host-owned vignette storage (Phase 1: the jailed core).
//
// A vignette persists state through the *host*, never by touching real IO — the
// host owns the backend, so this works identically whether the vignette is TS,
// wasm (sandboxed), or native. The shape mirrors wgutils-c/fileio (used as a
// feature reference, not a dependency): a **jailed in-memory mount** with
// synchronous read/write/delete/list, plus **async, host-driven restore/flush**
// to a pluggable durable backend. The sync/async split means no JSPI/Asyncify:
// the vignette only ever makes synchronous calls; durability is host-side async.
//
// Jail: every vignette-supplied path is normalized and confined under the mount
// root. Absolute paths, drive letters, and `..` escapes are rejected — a vignette
// cannot name its way to C:/windows or another session's data.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Thrown when a vignette-supplied path escapes its mount (attack or bug). */
export class StorageJailError extends Error {
  constructor(path: string) {
    super(`storage: path escapes the mount root: ${JSON.stringify(path)}`);
    this.name = 'StorageJailError';
  }
}

/**
 * Normalize a vignette-supplied path to a canonical mount-relative key
 * (`"a/b/c"`), or `null` if it escapes the jail. Leading slashes are treated as
 * root-relative and stripped (as wgutils-c's `fileio_init` does); `.`/empty
 * segments collapse; a `..` that would rise above the root, a drive letter, a
 * UNC prefix, or a NUL byte all reject.
 */
export function jailPath(input: string): string | null {
  if (typeof input !== 'string' || input.includes('\0')) return null;
  let p = input.replace(/\\/g, '/'); // unify separators
  if (/^[a-zA-Z]:/.test(p)) return null; // drive letter (C:...) → reject
  p = p.replace(/^\/+/, ''); // leading slash → root-relative
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // would escape above the root
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** jailPath that throws instead of returning null — for ops that must resolve. */
function resolveKey(path: string): string {
  const key = jailPath(path);
  if (key === null || key === '') throw new StorageJailError(path);
  return key;
}

/**
 * A single vignette's jailed, in-memory file tree. All ops are synchronous; the
 * durable side lives in {@link VignetteStorageSession}. Stored bytes are copied
 * on write so a caller reusing its buffer can't mutate what's held.
 */
export class MountedStorage {
  private readonly files = new Map<string, Uint8Array>();
  // Explicit directories (from mkdir, or auto-created as a file's ancestors).
  // Directories that merely contain a file are implicit — derived on demand — so
  // this set only needs to carry ones that would otherwise be empty.
  private readonly dirs = new Set<string>();

  read(path: string): Uint8Array | null {
    const bytes = this.files.get(resolveKey(path));
    return bytes ? bytes.slice() : null;
  }

  write(path: string, bytes: Uint8Array): void {
    const key = resolveKey(path);
    this.files.set(key, bytes.slice());
    this.addAncestors(key); // a write implies its parent directories (mkdir -p)
  }

  delete(path: string): boolean {
    return this.files.delete(resolveKey(path));
  }

  /** Create a directory and every missing parent (like `mkdir -p`). Idempotent. */
  mkdir(path: string): void {
    const key = jailPath(path);
    if (key === null) throw new StorageJailError(path);
    if (key === '') return; // the root always exists
    let prefix = '';
    for (const seg of key.split('/')) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      this.dirs.add(prefix);
    }
  }

  /** True if a file or directory exists at `path` (`""` = the always-present root). */
  exists(path: string): boolean {
    const key = jailPath(path);
    if (key === null) throw new StorageJailError(path);
    if (key === '') return true;
    return this.files.has(key) || this.isDirectory(key);
  }

  /** True if `path` is a directory — explicit (mkdir) or implied by a file under it. */
  isDirectory(path: string): boolean {
    const key = jailPath(path);
    if (key === null) throw new StorageJailError(path);
    if (key === '') return true;
    if (this.dirs.has(key)) return true;
    const prefix = `${key}/`;
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }

  /** Keys at or under `prefix` (default: all), sorted. `""` lists the whole mount. */
  list(prefix = ''): string[] {
    const jp = jailPath(prefix);
    if (jp === null) throw new StorageJailError(prefix);
    const keys = [...this.files.keys()].filter((k) => jp === '' || k === jp || k.startsWith(jp + '/'));
    return keys.sort();
  }

  /** Record every parent directory of a file key (mkdir -p on write). */
  private addAncestors(key: string): void {
    const parts = key.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i += 1) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      this.dirs.add(prefix);
    }
  }

  /** Number of files held. */
  get size(): number {
    return this.files.size;
  }

  /**
   * Serialize the whole mount to a deterministic archive (keys sorted), so a
   * flush of unchanged state produces identical bytes. Format (LE):
   *   [fileCount u32] { [keyLen u32][key][dataLen u32][data] }
   *   [dirCount u32]  { [keyLen u32][key] }             ← empty/explicit dirs
   */
  serialize(): Uint8Array {
    const fileKeys = [...this.files.keys()].sort();
    const dirKeys = [...this.dirs].sort();
    let total = 4;
    const files = fileKeys.map((k) => {
      const key = textEncoder.encode(k);
      const data = this.files.get(k)!;
      total += 4 + key.length + 4 + data.length;
      return { key, data };
    });
    total += 4;
    const dirs = dirKeys.map((k) => {
      const key = textEncoder.encode(k);
      total += 4 + key.length;
      return key;
    });
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let off = 0;
    view.setUint32(off, files.length, true);
    off += 4;
    for (const { key, data } of files) {
      view.setUint32(off, key.length, true);
      off += 4;
      out.set(key, off);
      off += key.length;
      view.setUint32(off, data.length, true);
      off += 4;
      out.set(data, off);
      off += data.length;
    }
    view.setUint32(off, dirs.length, true);
    off += 4;
    for (const key of dirs) {
      view.setUint32(off, key.length, true);
      off += 4;
      out.set(key, off);
      off += key.length;
    }
    return out;
  }

  /** Replace the mount's contents from an archive produced by {@link serialize}. */
  loadFrom(bytes: Uint8Array): void {
    this.files.clear();
    this.dirs.clear();
    if (bytes.length < 4) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 0;
    const fileCount = view.getUint32(off, true);
    off += 4;
    for (let i = 0; i < fileCount; i += 1) {
      const keyLen = view.getUint32(off, true);
      off += 4;
      const key = textDecoder.decode(bytes.subarray(off, off + keyLen));
      off += keyLen;
      const dataLen = view.getUint32(off, true);
      off += 4;
      this.files.set(key, bytes.slice(off, off + dataLen));
      off += dataLen;
    }
    if (off + 4 > bytes.length) return; // tolerate an archive with no dir section
    const dirCount = view.getUint32(off, true);
    off += 4;
    for (let i = 0; i < dirCount; i += 1) {
      const keyLen = view.getUint32(off, true);
      off += 4;
      this.dirs.add(textDecoder.decode(bytes.subarray(off, off + keyLen)));
      off += keyLen;
    }
  }
}

/**
 * The async durable backend, keyed by an opaque session scope. The app supplies
 * one — memory for tests, IndexedDB in a browser/worker, disk on a server. Only
 * whole-mount blobs cross this seam, and only on restore/flush.
 */
export interface DurableStore {
  load(scope: string): Promise<Uint8Array | null>;
  save(scope: string, bytes: Uint8Array): Promise<void>;
  remove(scope: string): Promise<void>;
}

/** In-memory DurableStore (tests / single-process). */
export function memoryDurableStore(): DurableStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    load: (scope) => Promise.resolve(blobs.has(scope) ? blobs.get(scope)!.slice() : null),
    save: (scope, bytes) => {
      blobs.set(scope, bytes.slice());
      return Promise.resolve();
    },
    remove: (scope) => {
      blobs.delete(scope);
      return Promise.resolve();
    },
  };
}

/**
 * Compose a safe session scope from the vignette id and an app-supplied storage
 * key (a save slot / room / user id — the *stable* handle that lets a reloaded
 * instance find its data). Both are sanitized into single jailed segments so a
 * peer can't craft a key that reaches another scope.
 */
export function scopeFor(vignetteId: string, storageKey: string): string {
  const seg = (s: string) => (jailPath(s) ?? '').replace(/\//g, '_') || '_';
  return `${seg(vignetteId)}/${seg(storageKey)}`;
}

/**
 * Ties a jailed in-memory {@link MountedStorage} to a {@link DurableStore} for
 * one session. The host drives the async edges: `restore()` before `init`,
 * `flush()` on a checkpoint. The vignette only ever touches `mount` synchronously.
 */
export class VignetteStorageSession {
  readonly mount: MountedStorage;

  constructor(
    private readonly scope: string,
    private readonly durable: DurableStore,
    mount: MountedStorage = new MountedStorage(),
  ) {
    this.mount = mount;
  }

  /** Load this scope's durable blob into the mount (call before `init`). */
  async restore(): Promise<void> {
    const bytes = await this.durable.load(this.scope);
    if (bytes) this.mount.loadFrom(bytes);
  }

  /** Persist the mount to durable storage (call on a checkpoint). */
  async flush(): Promise<void> {
    await this.durable.save(this.scope, this.mount.serialize());
  }

  /** Delete this scope's durable blob (e.g. on explicit reset). */
  async destroy(): Promise<void> {
    await this.durable.remove(this.scope);
  }
}
