# Build the reference WASM vignettes via emscripten. Adapted from
# examples/simple/vignette/wasm/config.nims, updated for the v2 vf_* exports.
#
#   cd test/wasm && nim c -d:emscripten counter.nim   -> out/counter_wasm.{js,wasm}

when declared(switch):
  import std/os

  switch("hints", "off")
  switch("nimcache", thisDir() & "/.nimcache")

  when defined(emscripten):
    let emsdk = getEnv("EMSCRIPTEN_SDK", "/home/rknopf/toolchains/emsdk")
    let emccPath = emsdk & "/upstream/emscripten"
    let currentPath = getEnv("PATH", "")
    putEnv("PATH", if currentPath.len == 0: emccPath else: emccPath & ":" & currentPath)

    if not dirExists(thisDir() & "/out"):
      mkdir(thisDir() & "/out")

    switch("os", "linux")
    switch("cpu", "wasm32")
    switch("cc", "clang")
    switch("clang.exe", "emcc")
    switch("clang.linkerexe", "emcc")
    switch("passC", "-I" & emsdk & "/cache/sysroot/include")
    switch("mm", "arc")
    switch("exceptions", "goto")
    switch("define", "noSignalHandler")

    switch("passL", "-sMODULARIZE=1")
    switch("passL", "-sEXPORT_ES6=1")
    switch("passL", "-sALLOW_MEMORY_GROWTH")
    switch("passL", "-sENVIRONMENT=web,worker,node")
    switch("passL", "-sNO_EXIT_RUNTIME=1")
    switch("passL", "-sERROR_ON_UNDEFINED_SYMBOLS=0")
    switch("passL", "-sEXPORTED_RUNTIME_METHODS=[\"HEAPU8\",\"ccall\",\"cwrap\"]")
    switch("passL", "-sEXPORTED_FUNCTIONS=[" &
      "\"_vf_init\",\"_vf_tick\",\"_vf_fixed_tick\",\"_vf_handle_message\"," &
      "\"_vf_peer_joined\",\"_vf_peer_left\",\"_vf_shutdown\"," &
      "\"_vf_outbox_offset\",\"_vf_outbox_capacity\"," &
      "\"_vf_frame_offset\",\"_vf_frame_len\",\"_vf_frame_seq\"," &
      "\"_vf_mem_alloc\",\"_vf_mem_free\",\"_malloc\",\"_free\",\"_main\"]")
    switch("passL", "-Oz")
    switch("passL", "-o " & thisDir() & "/out/" & projectName() & "_wasm.js")
