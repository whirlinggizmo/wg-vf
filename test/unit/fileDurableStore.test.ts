// fileDurableStore: the server (Bun/Node) disk backend. Real filesystem IO in a
// temp dir — proves save/load/remove, restore into a fresh store (a server
// restart), nested scopes, isolation, atomic writes, and the jail.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fileDurableStore } from '../../src';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wg-vf-fds-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fileDurableStore', () => {
  test('save/load/remove, and a fresh store over the same dir restores it (a server restart)', async () => {
    const s1 = fileDurableStore(dir);
    await s1.save('sim/slot1', new Uint8Array([1, 2, 3])); // scopeFor-style nested scope
    expect(Array.from((await s1.load('sim/slot1'))!)).toEqual([1, 2, 3]);

    const s2 = fileDurableStore(dir); // as after a process restart
    expect(Array.from((await s2.load('sim/slot1'))!)).toEqual([1, 2, 3]);
    expect(await s2.load('sim/absent')).toBeNull();

    await s2.remove('sim/slot1');
    expect(await s2.load('sim/slot1')).toBeNull();
  });

  test('scopes are independent', async () => {
    const s = fileDurableStore(dir);
    await s.save('room/a', new Uint8Array([1]));
    await s.save('room/b', new Uint8Array([2]));
    expect(Array.from((await s.load('room/a'))!)).toEqual([1]);
    expect(Array.from((await s.load('room/b'))!)).toEqual([2]);
  });

  test('a completed save leaves no temp file behind (atomic rename)', async () => {
    const s = fileDurableStore(dir);
    await s.save('atomic/x', new Uint8Array([7]));
    const files = await readdir(join(dir, 'atomic'));
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(files).toContain('x');
  });

  test('a scope that escapes the root is rejected', async () => {
    const s = fileDurableStore(dir);
    await expect(s.save('../evil', new Uint8Array([1]))).rejects.toThrow(/invalid scope/);
  });
});
