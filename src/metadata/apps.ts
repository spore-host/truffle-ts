// Application catalog — a seed of the external Go dep spore-host/libs/catalog
// (its catalog.yaml). truffle's `find` maps an app name (e.g. "paraview") to
// recommended instance families + minimum vCPU/memory, intersected with any
// hardware constraints in the same query. The full catalog has an overlay/
// online-resolve system; this ships the bundled entries verbatim (the whole
// current catalog is small). Grow as upstream grows.

/** One application's hardware recommendation (subset of Go catalog.AppEntry). */
export interface AppEntry {
  /** Canonical lowercase identifier, e.g. "paraview". */
  name: string;
  description: string;
  /** Recommended EC2 instance families, in preference order. */
  instanceFamilies: string[];
  /** Families for large-dataset / high-VRAM workloads. */
  highVramFamilies?: string[];
  minVcpus: number;
  minMemoryGiB: number;
  /** Whether a GPU is required. */
  gpu: boolean;
}

/** The bundled app catalog, keyed by canonical name. */
export const AppCatalog: Record<string, AppEntry> = {
  paraview: { name: "paraview", description: "Scientific visualization — CFD, FEA, large mesh", instanceFamilies: ["g6", "g5", "g4dn"], highVramFamilies: ["g6e"], minVcpus: 4, minMemoryGiB: 16, gpu: true },
  chimerax: { name: "chimerax", description: "Molecular visualization", instanceFamilies: ["g6", "g5"], minVcpus: 4, minMemoryGiB: 16, gpu: true },
  igv: { name: "igv", description: "Integrative Genomics Viewer", instanceFamilies: ["c7i", "m7i", "c6i"], minVcpus: 4, minMemoryGiB: 16, gpu: false },
  qgis: { name: "qgis", description: "Geographic information system", instanceFamilies: ["c7i", "m7i"], minVcpus: 4, minMemoryGiB: 8, gpu: false },
  fiji: { name: "fiji", description: "ImageJ image analysis", instanceFamilies: ["c7i", "m7i"], minVcpus: 4, minMemoryGiB: 16, gpu: false },
  ds9: { name: "ds9", description: "SAOImageDS9 astronomical imaging", instanceFamilies: ["c7i", "m7i"], minVcpus: 2, minMemoryGiB: 4, gpu: false },
};

/**
 * Look an app up by name (case-insensitive). Mirrors Go catalog.Lookup — used by
 * the parser to classify a bare word as an app token before hardware tokens.
 */
export function lookupApp(name: string): AppEntry | undefined {
  return AppCatalog[name.trim().toLowerCase()];
}
