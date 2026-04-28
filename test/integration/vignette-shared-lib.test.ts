import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const VIGNETTE_DIR = "examples/simple/vignette/wasm";
const SO_PATH = join(VIGNETTE_DIR, "out/libsimple-vignette.so");
const HEADER_PATH = join(VIGNETTE_DIR, "out/vignette.h");

// Expected exported symbols from the shared library
const EXPECTED_SYMBOLS = [
  "vf_init",
  "vf_tick",
  "vf_fixed_tick",
  "vf_handle_message",
  "vf_shutdown",
  "vf_outbox_offset",
  "vf_outbox_capacity",
  "vf_mem_alloc",
  "vf_mem_free",
];

describe("Vignette Shared Library", () => {
  test("builds shared library successfully", () => {
    // Clean first to ensure fresh build
    try {
      execSync("nim clean", { cwd: VIGNETTE_DIR, stdio: "pipe" });
    } catch {
      // Clean may fail if nothing exists, that's ok
    }

    // Build the shared library
    execSync("nim build shared", {
      cwd: VIGNETTE_DIR,
      stdio: "pipe",
      encoding: "utf-8",
    });

    expect(existsSync(SO_PATH)).toBe(true);
  }, 30000); // 30s timeout for compilation

  test("generates C header file", () => {
    expect(existsSync(HEADER_PATH)).toBe(true);
  });

  test("exports expected symbols", () => {
    expect(existsSync(SO_PATH)).toBe(true);

    // Use nm to list dynamic symbols
    const nmOutput = execSync(`nm -D ${SO_PATH}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Check each expected symbol is exported
    for (const symbol of EXPECTED_SYMBOLS) {
      expect(nmOutput).toContain(symbol);
    }
  });
});
