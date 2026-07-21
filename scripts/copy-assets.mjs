// Copy non-TS runtime assets into the library build. tsc emits .js/.d.ts but
// does not copy imported JSON, so the bundled catalog (src/data/instances.json)
// is copied here. No-op until the catalog lands (issue #5), so the scaffold
// build (issue #1) works before it exists.
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}src/data/instances.json`;
const destDir = `${root}dist/data`;
const dest = `${destDir}/instances.json`;

if (existsSync(src)) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log("copied instances.json → dist/data/");
} else {
  console.log("no src/data/instances.json yet — skipping (added in issue #5)");
}
