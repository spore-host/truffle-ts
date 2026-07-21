// Networking catalog — a direct port of the Go tool's pkg/metadata/network.go.
// EFA-capable families, bandwidth tiers, network-term aliases, and lookups.

import type { NetworkCapability } from "./types.js";

/** All instance families that support EFA (Elastic Fabric Adapter). */
export const EFACapableFamilies: string[] = [
  // Compute optimized
  "c5n", "c6a", "c6gn", "c6i", "c6id", "c6in", "c7a", "c7g", "c7gd", "c7gn", "c7i",
  // General purpose
  "m5dn", "m5n", "m5zn", "m6a", "m6i", "m6id", "m6idn", "m6in", "m7a", "m7g", "m7gd", "m7i", "m7i-flex",
  // Memory optimized
  "r5dn", "r5n", "r6a", "r6i", "r6id", "r6idn", "r6in", "r7a", "r7g", "r7gd", "r7i", "r7iz", "r8g",
  "x2idn", "x2iedn", "x2iezn",
  // Storage optimized
  "i3en", "i4g", "i4i", "im4gn", "is4gen",
  // Accelerated computing (GPU)
  "p3dn", "p4d", "p4de", "p5",
  // HPC optimized
  "hpc6a", "hpc6id", "hpc7a", "hpc7g",
];

/** Maps bandwidth tiers to the families that reach them. */
export const NetworkBandwidthTiers: Record<string, NetworkCapability> = {
  "10gbps": {
    maxBandwidthGbps: 10,
    families: ["m5", "m5a", "m5ad", "m5d", "c5", "c5a", "c5ad", "c5d", "r5", "r5a", "r5ad", "r5d", "t3", "t3a"],
  },
  "25gbps": {
    maxBandwidthGbps: 25,
    families: ["m5n", "m5dn", "m6i", "m6id", "m6a", "m6g", "m6gd", "c5n", "c6i", "c6id", "c6a", "c6g", "c6gd", "r5n", "r5dn", "r6i", "r6id", "r6a", "r6g", "r6gd", "p3", "p3dn", "g4dn", "g5"],
  },
  "50gbps": {
    maxBandwidthGbps: 50,
    families: ["m5zn", "m6idn", "m6in", "m7i", "m7i-flex", "m7a", "m7g", "m7gd", "c6in", "c6gn", "c7i", "c7a", "c7g", "c7gd", "c7gn", "r6idn", "r6in", "r7i", "r7iz", "r7a", "r7g", "r7gd", "r8g", "p4d", "p4de"],
  },
  "100gbps": {
    maxBandwidthGbps: 100,
    families: ["m6idn", "m6in", "m7i", "m7a", "m7g", "c6in", "c6gn", "c7i", "c7a", "c7g", "c7gn", "r6idn", "r6in", "r7i", "r7iz", "r7a", "r7g", "r8g", "x2idn", "x2iedn", "x2iezn", "i4i", "i4g", "im4gn", "is4gen", "p4d", "p4de", "p5", "hpc6a", "hpc6id", "hpc7a", "hpc7g"],
  },
  "200gbps": {
    maxBandwidthGbps: 200,
    families: ["p4d", "p4de", "p5", "hpc7g"],
  },
  "400gbps": {
    maxBandwidthGbps: 400,
    families: ["p5"],
  },
};

/** Maps common network terms to canonical forms. */
export const NetworkAliases: Record<string, string> = {
  efa: "efa",
  ena: "ena",
  "10g": "10gbps",
  "25g": "25gbps",
  "50g": "50gbps",
  "100g": "100gbps",
  "200g": "200gbps",
  "400g": "400gbps",
  highnet: "50gbps",
  ultranet: "100gbps",
  lowlatency: "efa",
};

/** Families that support at least `minGbps` of bandwidth (deduped, sorted). */
export function getFamiliesByNetworkSpeed(minGbps: number): string[] {
  const set = new Set<string>();
  for (const cap of Object.values(NetworkBandwidthTiers)) {
    if (cap.maxBandwidthGbps >= minGbps) for (const f of cap.families) set.add(f);
  }
  return [...set].sort();
}

/** Families that support EFA. */
export function getFamiliesByEFA(): string[] {
  return EFACapableFamilies;
}

/** Whether a family supports EFA. */
export function isEFASupported(family: string): boolean {
  return EFACapableFamilies.includes(family);
}
