// Build the C reference vignettes (counter/echo/faulty) to wasm via emscripten,
// and counter to a native .so via clang — for the PAR/DET/native test suites.
// Pure C: no Nim in the test toolchain. Needs emcc (emscripten) and clang.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const DIR = 'test/wasm';
const INC = 'src/vignettes/wasm';
const GLUE = `${INC}/wg_vf.c`;
const OUT = `${DIR}/out`;

const emsdk = process.env.EMSCRIPTEN_SDK || '/home/rknopf/toolchains/emsdk';
process.env.PATH = `${emsdk}/upstream/emscripten:${process.env.PATH ?? ''}`;

const EXPORTS = [
  '_vf_init', '_vf_tick', '_vf_fixed_tick', '_vf_handle_message',
  '_vf_peer_joined', '_vf_peer_left', '_vf_shutdown',
  '_vf_outbox_offset', '_vf_outbox_capacity',
  '_vf_frame_offset', '_vf_frame_len', '_vf_frame_seq',
  '_vf_mem_alloc', '_vf_mem_free', '_malloc', '_free',
].join(',');

mkdirSync(OUT, { recursive: true });

for (const v of ['counter', 'echo', 'faulty']) {
  execFileSync('emcc', [
    `${DIR}/${v}.c`, GLUE, `-I${INC}`, '-o', `${OUT}/${v}_wasm.js`,
    '-Oz', '--no-entry',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sALLOW_MEMORY_GROWTH',
    '-sENVIRONMENT=web,worker,node', '-sERROR_ON_UNDEFINED_SYMBOLS=0',
    '-sEXPORTED_RUNTIME_METHODS=HEAPU8', `-sEXPORTED_FUNCTIONS=${EXPORTS}`,
  ], { stdio: 'inherit' });
}

// Native shared library (counter), for the bun:ffi PAR-05 harness.
execFileSync('clang', [
  '-shared', '-fPIC', '-O2', `-I${INC}`, `${DIR}/counter.c`, GLUE, '-o', `${OUT}/libcounter.so`,
], { stdio: 'inherit' });

console.log('built reference vignettes: counter/echo/faulty (wasm) + libcounter.so (native)');
