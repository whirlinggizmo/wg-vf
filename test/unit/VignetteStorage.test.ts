// Host-owned vignette storage (src/storage/VignetteStorage): the path jail, the
// sync mount ops, and the async restore/flush round-trip. Pure logic — no host.

import { describe, expect, test } from 'bun:test';

import {
  MountedStorage,
  VignetteStorageSession,
  StorageJailError,
  jailPath,
  scopeFor,
  memoryDurableStore,
} from '../../src';

describe('path jail', () => {
  test('normalizes ordinary paths and strips leading slashes', () => {
    expect(jailPath('a/b/c')).toBe('a/b/c');
    expect(jailPath('/saves/slot1')).toBe('saves/slot1');
    expect(jailPath('a//b/./c')).toBe('a/b/c');
    expect(jailPath('a\\b\\c')).toBe('a/b/c'); // backslashes unified
    expect(jailPath('a/deep/../b')).toBe('a/b'); // interior .. that stays inside is fine
    expect(jailPath('\\\\server\\share')).toBe('server/share'); // UNC collapses to a confined path
  });

  test('rejects anything that escapes the mount', () => {
    expect(jailPath('../etc/passwd')).toBeNull();
    expect(jailPath('a/../../b')).toBeNull(); // rises above root
    expect(jailPath('C:/Windows/System32')).toBeNull();
    expect(jailPath('a\0b')).toBeNull(); // NUL byte
  });
});

describe('MountedStorage', () => {
  test('read/write/exists/delete round-trip and copy on write', () => {
    const m = new MountedStorage();
    const buf = new Uint8Array([1, 2, 3]);
    m.write('saves/slot1', buf);
    buf[0] = 9; // mutate the caller's buffer after write
    expect(Array.from(m.read('saves/slot1')!)).toEqual([1, 2, 3]); // stored copy is untouched
    expect(m.exists('saves/slot1')).toBe(true);
    expect(m.read('nope')).toBeNull();
    expect(m.delete('saves/slot1')).toBe(true);
    expect(m.exists('saves/slot1')).toBe(false);
  });

  test('list scopes to a prefix and stays sorted', () => {
    const m = new MountedStorage();
    m.write('a/2', new Uint8Array());
    m.write('a/1', new Uint8Array());
    m.write('b/1', new Uint8Array());
    expect(m.list()).toEqual(['a/1', 'a/2', 'b/1']);
    expect(m.list('a')).toEqual(['a/1', 'a/2']);
    expect(m.list('b')).toEqual(['b/1']);
  });

  test('mkdir -p creates a directory and all parents; exists/isDirectory see them', () => {
    const m = new MountedStorage();
    m.mkdir('assets/textures/hi');
    expect(m.isDirectory('assets')).toBe(true);
    expect(m.isDirectory('assets/textures')).toBe(true);
    expect(m.isDirectory('assets/textures/hi')).toBe(true);
    expect(m.exists('assets/textures')).toBe(true);
    expect(m.exists('assets/textures/hi')).toBe(true);
    expect(m.mkdir('assets/textures/hi')).toBeUndefined(); // idempotent
  });

  test('a write auto-creates its parent directories (mkdir -p on write)', () => {
    const m = new MountedStorage();
    m.write('levels/1/tiles.bin', new Uint8Array([1]));
    expect(m.exists('levels/1/tiles.bin')).toBe(true); // the file
    expect(m.isDirectory('levels/1')).toBe(true); // implied parent
    expect(m.isDirectory('levels')).toBe(true);
    expect(m.exists('levels/2')).toBe(false);
  });

  test('the root always exists', () => {
    const m = new MountedStorage();
    expect(m.exists('')).toBe(true);
    expect(m.isDirectory('/')).toBe(true);
  });

  test('an escaping path throws on every op', () => {
    const m = new MountedStorage();
    expect(() => m.write('../evil', new Uint8Array())).toThrow(StorageJailError);
    expect(() => m.read('../evil')).toThrow(StorageJailError);
    expect(() => m.delete('C:/x')).toThrow(StorageJailError);
    expect(() => m.list('../..')).toThrow(StorageJailError);
    expect(() => m.mkdir('../evil')).toThrow(StorageJailError);
  });

  test('an empty mkdir directory survives a serialize/loadFrom round-trip', () => {
    const a = new MountedStorage();
    a.mkdir('cache/empty');
    a.write('data', new Uint8Array([1]));
    const b = new MountedStorage();
    b.loadFrom(a.serialize());
    expect(b.isDirectory('cache/empty')).toBe(true); // empty dir preserved
    expect(Array.from(b.read('data')!)).toEqual([1]);
  });

  test('serialize is deterministic and round-trips through loadFrom', () => {
    const a = new MountedStorage();
    a.write('z', new Uint8Array([9]));
    a.write('a', new Uint8Array([1, 2]));
    const bytes1 = a.serialize();

    // Same contents inserted in a different order → identical bytes (keys sorted).
    const b = new MountedStorage();
    b.write('a', new Uint8Array([1, 2]));
    b.write('z', new Uint8Array([9]));
    expect(Array.from(b.serialize())).toEqual(Array.from(bytes1));

    const c = new MountedStorage();
    c.loadFrom(bytes1);
    expect(c.list()).toEqual(['a', 'z']);
    expect(Array.from(c.read('a')!)).toEqual([1, 2]);
    expect(Array.from(c.read('z')!)).toEqual([9]);
  });
});

describe('scopeFor', () => {
  test('sanitizes both components into safe single segments', () => {
    expect(scopeFor('sim', 'slot1')).toBe('sim/slot1');
    // An attacker-controlled storage key can't traverse into another scope.
    expect(scopeFor('sim', '../other')).toBe('sim/_'); // escape collapses to a safe token
    expect(scopeFor('sim', 'a/b')).toBe('sim/a_b'); // separators flattened
  });
});

describe('VignetteStorageSession', () => {
  test('flush then a fresh restore reconstitutes the mount', async () => {
    const durable = memoryDurableStore();
    const scope = scopeFor('sim', 'slot1');

    const first = new VignetteStorageSession(scope, durable);
    first.mount.write('state', new Uint8Array([42]));
    first.mount.write('meta/version', new Uint8Array([1]));
    await first.flush();

    // A brand-new session (as after a reload) restores the same bytes.
    const second = new VignetteStorageSession(scope, durable);
    await second.restore();
    expect(second.mount.list()).toEqual(['meta/version', 'state']);
    expect(Array.from(second.mount.read('state')!)).toEqual([42]);
  });

  test('restore with no prior blob leaves an empty mount; destroy clears it', async () => {
    const durable = memoryDurableStore();
    const scope = scopeFor('sim', 'slot2');

    const s = new VignetteStorageSession(scope, durable);
    await s.restore(); // nothing saved yet
    expect(s.mount.size).toBe(0);

    s.mount.write('x', new Uint8Array([1]));
    await s.flush();
    await s.destroy();

    const again = new VignetteStorageSession(scope, durable);
    await again.restore();
    expect(again.mount.size).toBe(0); // destroyed
  });
});
