import { defineConfig } from "vitest/config";

// truffle-ts is a LIBRARY first (built with tsc → dist/, see build:lib). This
// Vite config builds only the standalone demo site (→ site/) and runs the dev
// server + tests. The published package never depends on Vite output.
export default defineConfig({
  base: "./",
  build: {
    // The demo — a static page. The library itself is emitted by tsc to dist/.
    outDir: "site",
    target: "es2022",
    sourcemap: true,
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Exclude tests, pure type/interface decls, the barrels, and DOM entry
      // wiring that can't be meaningfully unit-covered.
      exclude: [
        "src/**/*.test.ts",
        "src/core/types.ts",
        "src/core/finder.ts", // pure interface — no executable code
        "src/index.ts",
        "src/main.ts",
        "src/metadata/index.ts",
      ],
      reporter: ["text", "html", "lcov"],
    },
  },
});
