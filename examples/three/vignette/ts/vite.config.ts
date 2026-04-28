import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  build: {
    outDir: resolve(__dirname, "out"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, "three-vignette.ts"),
      fileName: () => "three-vignette.js",
      formats: ["es"],
    },
    rollupOptions: {
      output: {
        entryFileNames: "three-vignette.js",
      },
    },
  },
});
