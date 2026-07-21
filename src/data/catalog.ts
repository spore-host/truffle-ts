// Loader for the bundled instance catalog — the committed snapshot in
// instances.json (see scripts/seed-catalog.mjs). Approximate, "as of 2026-01";
// not live AWS data. Imported as JSON so it's inlined by the bundler and needs
// no runtime fetch.

import type { InstanceType } from "../core/types.js";
import instances from "./instances.json" with { type: "json" };

/** The bundled instance catalog (a copy each call, safe for callers to mutate). */
export function loadBundledCatalog(): InstanceType[] {
  return (instances as InstanceType[]).map((it) => ({ ...it }));
}

/** Approximate date the bundled snapshot reflects, for UI staleness labels. */
export const CATALOG_AS_OF = "2026-01";
