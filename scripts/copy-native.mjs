// Copy the native ABI assets (the C header and the Nim framework glue) into
// dist/native so they ship with the package. Non-JS vignette authors compile
// against these: `#include <wg_vf.h>` + link wg_vf.c (C/Rust/Zig, or Nim via
// interop). Source of truth stays in src/vignettes/wasm/.

import { mkdirSync, copyFileSync } from 'node:fs';

const SRC = 'src/vignettes/wasm';
const DST = 'dist/native';
const FILES = ['wg_vf.h', 'wg_vf.c'];

mkdirSync(DST, { recursive: true });
for (const f of FILES) {
  copyFileSync(`${SRC}/${f}`, `${DST}/${f}`);
}
console.log(`copied native ABI assets (${FILES.join(', ')}) → ${DST}`);
