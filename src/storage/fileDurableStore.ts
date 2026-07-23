// Filesystem-backed DurableStore — the server (Bun/Node) durable backend, the
// disk analogue of indexedDbDurableStore. One file per scope under a root dir, so
// a server restart (or room teardown + re-provision) restores a vignette's state.
//
// Writes are atomic (temp file + rename) so a crash mid-write never leaves a
// half-written blob a later load would misread. Scopes are confined under the
// root — a scope can't escape to write elsewhere on disk.

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { jailPath, type DurableStore } from './VignetteStorage.js';

interface ErrnoException {
  code?: string;
}

/** A DurableStore that persists each scope's blob as a file under `rootDir`. */
export function fileDurableStore(rootDir: string): DurableStore {
  const pathFor = (scope: string): string => {
    const safe = jailPath(scope);
    if (safe === null || safe === '') {
      throw new Error(`fileDurableStore: invalid scope ${JSON.stringify(scope)}`);
    }
    return join(rootDir, safe);
  };

  return {
    async load(scope) {
      try {
        const buf = await readFile(pathFor(scope));
        return new Uint8Array(buf); // copy out of the Buffer as a plain Uint8Array
      } catch (err) {
        if ((err as ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(scope, bytes) {
      const path = pathFor(scope);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, path); // atomic replace — a load never sees a partial write
    },
    async remove(scope) {
      await rm(pathFor(scope), { force: true });
    },
  };
}
