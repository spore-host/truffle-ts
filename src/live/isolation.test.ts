// @vitest-environment node
//
// The load-bearing guarantee of the ./live split: the default "." (offline)
// import must NEVER pull in the AWS SDK, so browser consumers of `find` don't
// ship ~10MB of SDK. This walks the SOURCE import graph reachable from
// src/index.ts and asserts no file imports "@aws-sdk/*" or anything under
// src/live/. A source-graph check runs without a build and catches the
// regression the moment a stray import is added.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const srcDir = fileURLToPath(new URL("..", import.meta.url)); // .../src

/** Collect every local module reachable from `entry` via static imports. */
function importGraph(entryRel: string): string[] {
  const seen = new Set<string>();
  const importsOf = (file: string): string[] => {
    const text = readFileSync(file, "utf8");
    const re = /(?:import|export)[^'"]*from\s*["']([^"']+)["']/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return out;
  };
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importsOf(file)) {
      if (!spec.startsWith(".")) continue; // external — recorded by the caller
      const path = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
      try {
        walk(path);
      } catch {
        // .json or missing — ignore for graph purposes
      }
    }
  };
  walk(resolve(srcDir, entryRel));
  return [...seen];
}

/** External (bare) specifiers imported anywhere in the graph. */
function externalImports(files: string[]): string[] {
  const ext = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const re = /(?:import|export)[^'"]*from\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!m[1].startsWith(".")) ext.add(m[1]);
    }
  }
  return [...ext];
}

describe("offline-import isolation", () => {
  it("the default '.' entry graph never imports the AWS SDK or src/live", () => {
    const graph = importGraph("index.ts");
    // No file under src/live is reachable from index.ts.
    expect(graph.some((f) => f.includes("/live/"))).toBe(false);
    // No AWS SDK anywhere in the graph.
    expect(externalImports(graph).some((e) => e.startsWith("@aws-sdk/"))).toBe(false);
  });

  it("the './metadata' entry graph is likewise SDK-free", () => {
    const graph = importGraph("metadata/index.ts");
    expect(externalImports(graph).some((e) => e.startsWith("@aws-sdk/"))).toBe(false);
  });

  it("the './live' entry DOES use the AWS SDK (sanity: it's the live path)", () => {
    const graph = importGraph("live/index.ts");
    expect(externalImports(graph).some((e) => e.startsWith("@aws-sdk/"))).toBe(true);
  });
});
