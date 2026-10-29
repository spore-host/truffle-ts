// Application catalog — generated from the Go suite's spore-host/libs
// catalog/catalog.yaml (see apps.generated.ts and scripts/gen-upstream.mjs).
// truffle's `find` maps an app name or alias (e.g. "paraview", "pv") to
// recommended instance families + minimum vCPU/memory, intersected with any
// hardware constraints in the same query.
//
// This used to be a hand-copied subset, and it drifted (#30): the aliases were
// dropped, so `find("imagej")`, `find("pv")` and `find("chimera")` stopped
// resolving, every description differed from upstream, and chimerax lost its
// high-VRAM family. The copy is now generated and drift-checked.
//
// Only the hardware fields are carried. Image, recipe, launch command and port
// are launch-time concerns of the Go `spawn` tool and have no meaning here.

import { UPSTREAM_APPS } from "./apps.generated.js";

/** The launch shape of an app (libs catalog `kind`; empty upstream = "application"). */
export type AppKind = "application" | "desktop" | "web";

/** One application's hardware recommendation (subset of Go catalog.AppEntry). */
export interface AppEntry {
  /** Canonical lowercase identifier, e.g. "paraview". */
  name: string;
  description: string;
  /** "application" (one GUI app over DCV), "desktop" (a bare desktop) or "web". */
  kind: AppKind;
  /** Recommended EC2 instance families, in preference order. */
  instanceFamilies: string[];
  /** Families for large-dataset / high-VRAM workloads. */
  highVramFamilies?: string[];
  minVcpus: number;
  minMemoryGiB: number;
  /** Whether a GPU is required. */
  gpu: boolean;
  /** Minimum GPU VRAM in GiB (only meaningful when `gpu` is true). */
  minVramGiB?: number;
  /** Other names the app is known by, lowercase, e.g. ["imagej"] for fiji. */
  aliases: string[];
  /** License class, e.g. "open-source". */
  license?: string;
}

/** The app catalog, keyed by canonical name. */
export const AppCatalog: Record<string, AppEntry> = Object.fromEntries(
  UPSTREAM_APPS.map((e) => [e.name, e]),
);

/** Name AND alias → entry, as Go's catalog builds its byAlias map. */
const byAlias = new Map<string, AppEntry>();
for (const e of UPSTREAM_APPS) {
  byAlias.set(e.name, e);
  for (const a of e.aliases) byAlias.set(a.toLowerCase(), e);
}

/**
 * Look an app up by name or alias (case-insensitive). Mirrors Go
 * catalog.Lookup — used by the parser to classify a bare word as an app token
 * before hardware tokens. `lookupApp("imagej")` returns the fiji entry.
 */
export function lookupApp(name: string): AppEntry | undefined {
  return byAlias.get(name.trim().toLowerCase());
}

/** All entries sorted alphabetically by name, as Go catalog.List (`truffle app list`). */
export function listApps(): AppEntry[] {
  return [...UPSTREAM_APPS].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export { APP_CATALOG_SOURCE } from "./apps.generated.js";
