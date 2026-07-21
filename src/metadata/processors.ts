// CPU processor catalog — a direct port of the Go tool's
// pkg/metadata/processors.go. Maps processor code names to vendor/arch/
// generation/families, plus vendor aliases and family lookup helpers.

import type { ProcessorInfo } from "./types.js";

/** Maps processor code names to their information. */
export const ProcessorDatabase: Record<string, ProcessorInfo> = {
  // Intel processors
  "emerald rapids": { codeName: "Emerald Rapids", vendor: "intel", architecture: "x86_64", generation: "5th gen", families: ["m8i", "c8i", "r8i"] },
  "sapphire rapids": { codeName: "Sapphire Rapids", vendor: "intel", architecture: "x86_64", generation: "4th gen", families: ["m7i", "c7i", "r7i", "r7iz", "m7i-flex"] },
  "ice lake": { codeName: "Ice Lake", vendor: "intel", architecture: "x86_64", generation: "3rd gen", families: ["m6i", "c6i", "r6i", "r6id", "r6idn", "m6id", "m6idn", "c6id", "c6in"] },
  "cascade lake": { codeName: "Cascade Lake", vendor: "intel", architecture: "x86_64", generation: "2nd gen", families: ["m5", "c5", "r5", "m5n", "m5dn", "c5n", "r5n", "r5dn", "m5d", "c5d", "r5d"] },
  "skylake": { codeName: "Skylake", vendor: "intel", architecture: "x86_64", generation: "1st gen", families: ["m5", "c5", "r5", "z1d"] },
  "haswell": { codeName: "Haswell", vendor: "intel", architecture: "x86_64", generation: "legacy", families: ["m4", "c4", "r4", "t2", "d2", "i2"] },
  "broadwell": { codeName: "Broadwell", vendor: "intel", architecture: "x86_64", generation: "legacy", families: ["m4", "c4", "t2", "d2"] },
  "ivy bridge": { codeName: "Ivy Bridge", vendor: "intel", architecture: "x86_64", generation: "legacy", families: ["m3", "c3", "r3", "i2"] },
  "sandy bridge": { codeName: "Sandy Bridge", vendor: "intel", architecture: "x86_64", generation: "legacy", families: ["m1", "c1", "m2", "t1"] },

  // AMD processors
  "milan": { codeName: "Milan", vendor: "amd", architecture: "x86_64", generation: "3rd gen", families: ["m6a", "c6a", "r6a", "r6id", "hpc6a"] },
  "rome": { codeName: "Rome", vendor: "amd", architecture: "x86_64", generation: "2nd gen", families: ["m5a", "c5a", "r5a", "m5ad", "r5ad"] },
  "genoa": { codeName: "Genoa", vendor: "amd", architecture: "x86_64", generation: "4th gen", families: ["m7a", "c7a", "r7a", "hpc7a"] },
  "bergamo": { codeName: "Bergamo", vendor: "amd", architecture: "x86_64", generation: "4th gen", families: ["m7a", "c7a"] },
  "turin": { codeName: "Turin", vendor: "amd", architecture: "x86_64", generation: "5th gen", families: ["m8a", "c8a", "r8a"] },
  "zen 3": { codeName: "Zen 3", vendor: "amd", architecture: "x86_64", generation: "3rd gen", families: ["m6a", "c6a", "r6a", "hpc6a"] },
  "zen 4": { codeName: "Zen 4", vendor: "amd", architecture: "x86_64", generation: "4th gen", families: ["m7a", "c7a", "r7a", "hpc7a"] },
  "zen 5": { codeName: "Zen 5", vendor: "amd", architecture: "x86_64", generation: "5th gen", families: ["m8a", "c8a", "r8a"] },

  // AWS Graviton processors
  "graviton": { codeName: "Graviton", vendor: "aws", architecture: "arm64", generation: "1st gen", families: ["a1"] },
  "graviton2": { codeName: "Graviton2", vendor: "aws", architecture: "arm64", generation: "2nd gen", families: ["m6g", "c6g", "r6g", "t4g", "m6gd", "c6gd", "r6gd", "c6gn", "im4gn", "is4gen", "x2gd"] },
  "graviton3": { codeName: "Graviton3", vendor: "aws", architecture: "arm64", generation: "3rd gen", families: ["m7g", "c7g", "r7g", "c7gn", "hpc7g", "c7gd", "m7gd", "r7gd"] },
  "graviton3e": { codeName: "Graviton3E", vendor: "aws", architecture: "arm64", generation: "3rd gen", families: ["c7gn", "hpc7g"] },
  "graviton4": { codeName: "Graviton4", vendor: "aws", architecture: "arm64", generation: "4th gen", families: ["r8g"] },
};

/** Maps common vendor names to canonical forms. */
export const VendorAliases: Record<string, string> = {
  intel: "intel",
  amd: "amd",
  aws: "aws",
  graviton: "aws",
  arm: "aws",
  amazon: "aws",
};

/** All processors for a given vendor. */
export function getProcessorsByVendor(vendor: string): ProcessorInfo[] {
  return Object.values(ProcessorDatabase).filter((p) => p.vendor === vendor);
}

/** All instance families for a given vendor (deduplicated, sorted for stability). */
export function getFamiliesByVendor(vendor: string): string[] {
  const set = new Set<string>();
  for (const info of Object.values(ProcessorDatabase)) {
    if (info.vendor === vendor) for (const f of info.families) set.add(f);
  }
  return [...set].sort();
}
