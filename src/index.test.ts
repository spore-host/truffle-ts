import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./index.js";

describe("library scaffold", () => {
  it("exports a VERSION matching package.json", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
