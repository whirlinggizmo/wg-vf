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

  test("header declarations match exported symbols", () => {
    expect(existsSync(SO_PATH)).toBe(true);
    expect(existsSync(HEADER_PATH)).toBe(true);

    // Read header and extract function declarations
    const headerContent = execSync(`cat ${HEADER_PATH}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Parse function names from header (e.g., "uint32_t vf_init(...)")
    const headerFunctions: string[] = [];
    const functionRegex = /uint32_t\s+(vf_\w+)|void\s+(vf_\w+)|\s+(vf_\w+)\(/g;
    let match;
    while ((match = functionRegex.exec(headerContent)) !== null) {
      const funcName = match[1] || match[2] || match[3];
      if (funcName && !headerFunctions.includes(funcName)) {
        headerFunctions.push(funcName);
      }
    }

    // Get exported symbols from .so
    const nmOutput = execSync(`nm -D ${SO_PATH}`, {
      encoding: "utf-8",
      stdio: "pipe",
    });

    // Extract function names from nm output (lines like "000000 T vf_init")
    const exportedFunctions: string[] = [];
    const nmRegex = /T\s+(vf_\w+)/g;
    while ((match = nmRegex.exec(nmOutput)) !== null) {
      exportedFunctions.push(match[1]);
    }

    // Compare: every header function should be exported
    for (const func of headerFunctions) {
      expect(exportedFunctions).toContain(func);
    }

    // Compare: every expected function should be in header
    for (const func of EXPECTED_SYMBOLS) {
      expect(headerFunctions).toContain(func);
    }

    // Check for extraneous exports: symbols in .so but NOT in header
    const headerSet = new Set(headerFunctions);
    const extraneousExports = exportedFunctions.filter(f => !headerSet.has(f));
    if (extraneousExports.length > 0) {
      console.warn("Extraneous exports not in header:", extraneousExports);
    }
    expect(extraneousExports).toEqual([]);
  });
});
