// Emscripten JS library: the wasm side of the Vignette FS ABI. Each wg_vf_fs_*
// import decodes its UTF-8 path from the module heap and dispatches to the
// per-instance host filesystem at `Module.wgVfFs` (a VignetteFs the host sets in
// WasmVignette.attachServices, before init). Wired in via --js-library.
// See docs/vignette-fs-abi.md. Error codes: -1 not found, -2 buffer too small,
// -3 jail violation (or any op throw), -4 no fs configured.
mergeInto(LibraryManager.library, {
  $wgVfPath: function (ptr, len) {
    return new TextDecoder().decode(HEAPU8.subarray(ptr, ptr + len));
  },

  wg_vf_fs_size__deps: ['$wgVfPath'],
  wg_vf_fs_size: function (pathPtr, pathLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      var b = fs.read(wgVfPath(pathPtr, pathLen));
      return b ? b.length : -1;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_read__deps: ['$wgVfPath'],
  wg_vf_fs_read: function (pathPtr, pathLen, outPtr, outCap) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      var b = fs.read(wgVfPath(pathPtr, pathLen));
      if (!b) return -1;
      if (b.length > outCap) return -2;
      HEAPU8.set(b, outPtr);
      return b.length;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_write__deps: ['$wgVfPath'],
  wg_vf_fs_write: function (pathPtr, pathLen, dataPtr, dataLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      fs.write(wgVfPath(pathPtr, pathLen), HEAPU8.slice(dataPtr, dataPtr + dataLen));
      return 0;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_delete__deps: ['$wgVfPath'],
  wg_vf_fs_delete: function (pathPtr, pathLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      return fs.delete(wgVfPath(pathPtr, pathLen)) ? 1 : 0;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_exists__deps: ['$wgVfPath'],
  wg_vf_fs_exists: function (pathPtr, pathLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      return fs.exists(wgVfPath(pathPtr, pathLen)) ? 1 : 0;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_is_dir__deps: ['$wgVfPath'],
  wg_vf_fs_is_dir: function (pathPtr, pathLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      return fs.isDirectory(wgVfPath(pathPtr, pathLen)) ? 1 : 0;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_mkdir__deps: ['$wgVfPath'],
  wg_vf_fs_mkdir: function (pathPtr, pathLen) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      fs.mkdir(wgVfPath(pathPtr, pathLen));
      return 0;
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_list__deps: ['$wgVfPath'],
  wg_vf_fs_list: function (prefixPtr, prefixLen, outPtr, outCap) {
    var fs = Module.wgVfFs;
    if (!fs) return -4;
    try {
      var keys = fs.list(wgVfPath(prefixPtr, prefixLen));
      var bytes = new TextEncoder().encode(keys.join('\0'));
      if (bytes.length <= outCap) HEAPU8.set(bytes, outPtr);
      return bytes.length; // may exceed out_cap → caller retries with a bigger buffer
    } catch (e) {
      return -3;
    }
  },

  wg_vf_fs_flush: function () {
    var fs = Module.wgVfFs;
    if (fs) fs.flush(); // async barrier; fire-and-forget from wasm's side
  },
});
