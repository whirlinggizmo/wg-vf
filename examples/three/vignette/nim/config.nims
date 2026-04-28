# vignette/config.nims

# our linter complains about nimscript.  To supress the warnings, we put a declared() guard
when declared(switch):
  import std/strutils
  import os # for commandLineParams


  switch("hints", "off")
  switch("verbosity", "1") # disable verbose output

  const buildTypes = @["js", "wasm", "shared", "c", "cpp", "all"]
  const outDir = "./out"
  const vignetteName = "three-vignette"
  const mainEntryFile = "src/main.nim"


  switch("path", thisDir()) # for shared and lib
  switch("path", thisDir() & "/../../../../src") # for framework vignette module


  proc ensureDirExists*(dir: string) =
    if dirExists(dir):
      return
    echo "Creating directory: " & dir
    mkdir(dir)

  proc configureCommon*(vignetteName: string) =
    switch("nimcache", thisDir() & "/.nimcache")
    switch("path", thisDir() &  "/src")
    switch("lineTrace", "on")
    switch("stackTrace", "on")
    switch("sourceMap")


  when defined(js):
    echo "Configuring " & vignetteName & " for JS"

    configureCommon(vignetteName)

    let outFilename = vignetteName.toLower() & ".js" 
    ensureDirExists(outDir) 
    switch("out", outDir & "/" & outFilename)

  when defined(emscripten):
    echo "Configuring " & vignetteName & " for WASM"

    configureCommon(vignetteName)

    let emsdk = getEnv("EMSCRIPTEN_SDK", "/home/rknopf/toolchains/emsdk")
    if not dirExists(emsdk):
      echo "EMSCRIPTEN_SDK directory not found: " & emsdk
      quit(1)
    putEnv("EMSCRIPTEN_SDK", emsdk)
    let emccPath = emsdk & "/upstream/emscripten"
    if not dirExists(emccPath):
      echo "Emscripten tools directory not found: " & emccPath
      quit(1)
    let currentPath = getEnv("PATH", "")
    if currentPath.len == 0:
      putEnv("PATH", emccPath)
    else:
      putEnv("PATH", emccPath & ":" & currentPath)

    let outFilename = vignetteName.toLower() & "_wasm.js"
    ensureDirExists(outDir)

    switch("define", "wasm")
    switch("os", "linux")
    switch("cpu", "wasm32")
    switch("cc", "clang")
    when defined(windows):
      switch("clang.exe", "emcc.bat")
      switch("clang.linkerexe", "emcc.bat")
    else:
      switch("clang.exe", "emcc")
      switch("clang.linkerexe", "emcc")
    switch("passC", "-I" & emsdk & "/cache/sysroot/include")
    switch("mm", "arc")
    switch("exceptions", "goto")
    switch("define", "noSignalHandler")
    switch("passL", "-o " & outDir & "/" & outFilename)
    switch("passL", "-sMODULARIZE=1")
    switch("passL", "-sALLOW_MEMORY_GROWTH")
    switch("passL", "-sIMPORTED_MEMORY=1")
    switch("passL", "-sUSE_PTHREADS=0")
    switch("passL", "-sMAXIMUM_MEMORY=536870912")
    switch("passL", "-sEXPORT_ES6=1")
    switch("passL", "-sENVIRONMENT=web,worker,node")
    switch("passL", "-sASSERTIONS=1")
    switch("passL", "-sNO_EXIT_RUNTIME=1")
    switch("passL", "-sWASM=1")
    switch("passL", "-sERROR_ON_UNDEFINED_SYMBOLS=0")
    switch("passL", "-v")
    switch("passL", "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\",\"addFunction\",\"lengthBytesUTF8\",\"stringToUTF8\",\"UTF8ToString\"]")
    switch("passL", "-sALLOW_TABLE_GROWTH")
    switch("passL", "-sEXPORTED_FUNCTIONS=[\"_vf_init\",\"_vf_tick\",\"_vf_fixed_tick\",\"_vf_handle_message\",\"_vf_shutdown\",\"_vf_outbox_offset\",\"_vf_outbox_capacity\",\"_vf_mem_alloc\",\"_vf_mem_free\",\"_malloc\",\"_free\",\"_main\"]")
    switch("passL", "-Oz")

  when defined(shared):
    echo "Configuring " & vignetteName & " for Shared Library (.so)"

    configureCommon(vignetteName)

    let outFilename = "lib" & vignetteName.toLower() & ".so"
    ensureDirExists(outDir)

    switch("app", "lib")
    switch("out", outDir & "/" & outFilename)
    switch("define", "shared")
    switch("mm", "arc")

  proc printUsage() =
    echo "Usage: nim build [js|wasm|shared|c|cpp|all]"
    echo "       nim clean"
    echo ""
    echo "If no build type is provided, builds 'all' (js + wasm + shared)"

  proc taskParams(): seq[string] =
    result = commandLineParams()
    while result.len > 0 and result[0].startsWith("-"):
      result.delete(0)

  proc buildSingle(buildType: string): bool =
    var commandType = "js"
    var commandDefines: seq[string] = @[]
    var commandFlags: seq[string] = @[]
    case buildType:
      of "js":
        commandType = "js"
        commandDefines.add("js")
        commandDefines.add("nodejs")
      of "wasm":
        commandType = "c"
        commandDefines.add("emscripten")
      of "shared":
        commandType = "c"
        commandDefines.add("shared")
      of "c":
        echo "Refusing to build for C, this probably isn't what you want."
        return false
      of "cpp":
        echo "Refusing to build for C++, this probably isn't what you want."
        return false
      else:
        echo "Unknown build type: " & buildType
        return false

    echo "Building " & vignetteName & " for " & buildType.toUpper() & "..."
    try:
      var cmd = commandType & " "
      if commandFlags.len > 0: cmd &= commandFlags.join(" ") & " "
      if commandDefines.len > 0: cmd &= "-d:" & commandDefines.join(" -d:") & " "
      cmd &= mainEntryFile
      echo "Running command: nim " & cmd & "..."
      withDir(thisDir()):
        selfExec(cmd)
    except:
      echo "Failed to build " & vignetteName & " for " & buildType.toUpper()
      return false
    echo "Build complete for " & buildType.toUpper() & "."

    # Copy header to out directory for shared library builds
    if buildType == "shared":
      let srcHeader = thisDir() & "/../../../../src/vignettes/vignette.h"
      let outHeader = outDir & "/vignette.h"
      if fileExists(srcHeader):
        echo "Copying header to " & outHeader & "..."
        let cpCmd = "cp " & srcHeader & " " & outHeader
        exec(cpCmd)

    return true

  task build, "build [build_type]":
    let params = taskParams()
    if params.len > 1 and (params[1].toLower() == "help" or params[0].toLower() == "--help"):
      printUsage()
      return

    var buildType = if params.len > 1: params[1].toLower() else: "all"
    if buildType notin buildTypes:
      echo "Unknown build type: " & buildType
      printUsage()
      return

    if buildType == "all":
      echo "Building all targets (js + wasm + shared)..."
      let jsSuccess = buildSingle("js")
      let wasmSuccess = buildSingle("wasm")
      let sharedSuccess = buildSingle("shared")
      if jsSuccess and wasmSuccess and sharedSuccess:
        echo "All builds complete."
      else:
        echo "One or more builds failed."
        quit(1)
    else:
      let success = buildSingle(buildType)
      if not success:
        quit(1)
    
  task clean, "clean":
    let params = taskParams()
    if params.len > 1 and (params[1].toLower() == "help" or params[0].toLower() == "--help"):
      printUsage()
      return

    echo "Cleaning " & vignetteName & "..."
    try:
      let cacheDir = vignetteName & "/.nimcache"
      let jsOut = outDir & "/" & vignetteName.toLower() & ".js"
      let jsMap = jsOut & ".map"
      let wasmJs = outDir & "/" & vignetteName.toLower() & "_wasm.js"
      let wasmJsMap = wasmJs & ".map"
      let wasmHash = wasmJs & ".hash"
      let wasmFile = outDir & "/" & vignetteName.toLower() & "_wasm.wasm"
      let wasmOptFile = outDir & "/" & vignetteName.toLower() & "_wasm.opt.wasm"
      let sharedLibFile = outDir & "/lib" & vignetteName.toLower() & ".so"
      let headerFile = outDir & "/vignette.h"

      var cmd = "rm -rf " & cacheDir &
        " " & jsOut &
        " " & jsMap &
        " " & wasmJs &
        " " & wasmJsMap &
        " " & wasmHash &
        " " & wasmFile &
        " " & wasmOptFile &
        " " & sharedLibFile &
        " " & headerFile
      echo "Running command: " & cmd & "..."
      withDir(thisDir()):
        exec(cmd)
    except:
      echo "Failed to clean " & vignetteName
      return
    echo "Clean complete."
