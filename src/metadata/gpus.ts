// GPU / accelerator catalog — a direct port of the Go tool's
// pkg/metadata/gpus.go. Maps GPU names to memory/use-case/families/exact
// instance types, plus aliases and vendor/use-case lookups.

import type { GPUInfo } from "./types.js";

/** Maps GPU names to their information. */
export const GPUDatabase: Record<string, GPUInfo> = {
  // NVIDIA Training GPUs
  "h200": { name: "H200", vendor: "nvidia", memoryGB: 141, useCase: "training", families: ["p5e"], instanceTypes: ["p5e.48xlarge"] },
  "h100": { name: "H100", vendor: "nvidia", memoryGB: 80, useCase: "training", families: ["p5"], instanceTypes: ["p5.48xlarge"] },
  "a100": { name: "A100", vendor: "nvidia", memoryGB: 40, useCase: "training", families: ["p4d", "p4de"], instanceTypes: ["p4d.24xlarge", "p4de.24xlarge"] },
  "v100": { name: "V100", vendor: "nvidia", memoryGB: 16, useCase: "training", families: ["p3"], instanceTypes: ["p3.2xlarge", "p3.8xlarge", "p3.16xlarge", "p3dn.24xlarge"] },
  "k80": { name: "K80", vendor: "nvidia", memoryGB: 12, useCase: "legacy", families: ["p2"], instanceTypes: ["p2.xlarge", "p2.8xlarge", "p2.16xlarge"] },
  "m60": { name: "M60", vendor: "nvidia", memoryGB: 8, useCase: "graphics", families: ["g3"], instanceTypes: ["g3s.xlarge", "g3.4xlarge", "g3.8xlarge", "g3.16xlarge"] },

  // NVIDIA Inference GPUs
  "a10g": { name: "A10G", vendor: "nvidia", memoryGB: 22, useCase: "inference", families: ["g5"], instanceTypes: ["g5.xlarge", "g5.2xlarge", "g5.4xlarge", "g5.8xlarge", "g5.12xlarge", "g5.16xlarge", "g5.24xlarge", "g5.48xlarge"] },
  "t4": { name: "T4", vendor: "nvidia", memoryGB: 16, useCase: "inference", families: ["g4dn"], instanceTypes: ["g4dn.xlarge", "g4dn.2xlarge", "g4dn.4xlarge", "g4dn.8xlarge", "g4dn.12xlarge", "g4dn.16xlarge", "g4dn.metal"] },
  "l4": { name: "L4", vendor: "nvidia", memoryGB: 22, useCase: "inference", families: ["g6"], instanceTypes: ["g6.xlarge", "g6.2xlarge", "g6.4xlarge", "g6.8xlarge", "g6.12xlarge", "g6.16xlarge", "g6.24xlarge", "g6.48xlarge"] },
  "l40s": { name: "L40S", vendor: "nvidia", memoryGB: 44, useCase: "inference", families: ["g6e"], instanceTypes: ["g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.12xlarge", "g6e.16xlarge", "g6e.24xlarge", "g6e.48xlarge"] },
  "rtx pro server 6000": { name: "RTX PRO Server 6000", vendor: "nvidia", memoryGB: 96, useCase: "graphics", families: ["g7e"], instanceTypes: ["g7e.2xlarge", "g7e.4xlarge", "g7e.8xlarge", "g7e.12xlarge", "g7e.24xlarge", "g7e.48xlarge"] },
  "rtx pro 4500": { name: "RTX PRO 4500", vendor: "nvidia", memoryGB: 32, useCase: "graphics", families: ["g7"], instanceTypes: ["g7.2xlarge", "g7.4xlarge", "g7.8xlarge", "g7.12xlarge", "g7.24xlarge", "g7.48xlarge"] },
  "b200": { name: "B200", vendor: "nvidia", memoryGB: 179, useCase: "training", families: ["p6"], instanceTypes: ["p6-b200.48xlarge", "p6e-gb200.36xlarge"] },
  "b300": { name: "B300", vendor: "nvidia", memoryGB: 268, useCase: "training", families: ["p6"], instanceTypes: ["p6-b300.48xlarge"] },

  // NVIDIA (vendor-level entry for "nvidia" keyword matching)
  "nvidia": { name: "NVIDIA (all)", vendor: "nvidia", memoryGB: 0, useCase: "any", families: ["p5e", "p5", "p4d", "p4de", "p3", "p2", "g3", "g5", "g4dn", "g6", "g6e", "g7", "g7e", "p6"] },

  // AMD GPUs
  "radeon pro v520": { name: "Radeon Pro V520", vendor: "amd", memoryGB: 8, useCase: "graphics", families: ["g4ad"], instanceTypes: ["g4ad.xlarge", "g4ad.2xlarge", "g4ad.4xlarge", "g4ad.8xlarge", "g4ad.16xlarge"] },

  // AWS Accelerators
  "inferentia": { name: "Inferentia", vendor: "aws", memoryGB: 8, useCase: "inference", families: ["inf1"], instanceTypes: ["inf1.xlarge", "inf1.2xlarge", "inf1.6xlarge", "inf1.24xlarge"] },
  "inferentia2": { name: "Inferentia2", vendor: "aws", memoryGB: 32, useCase: "inference", families: ["inf2"], instanceTypes: ["inf2.xlarge", "inf2.8xlarge", "inf2.24xlarge", "inf2.48xlarge"] },
  "trainium": { name: "Trainium", vendor: "aws", memoryGB: 32, useCase: "training", families: ["trn1", "trn1n"], instanceTypes: ["trn1.2xlarge", "trn1.32xlarge", "trn1n.32xlarge"] },
};

/** Maps common GPU names / marketing spellings to canonical GPUDatabase keys. */
export const GPUAliases: Record<string, string> = {
  nvidia: "nvidia",
  inf: "inferentia",
  inf1: "inferentia",
  inf2: "inferentia2",
  trn: "trainium",
  trn1: "trainium",
  a10: "a10g",
  radeon: "radeon pro v520",
  v520: "radeon pro v520",
  neuron: "inferentia",
  inferent: "inferentia",
  h200: "h200",
  l40: "l40s",
  rtx: "rtx pro server 6000",
  rtx6000: "rtx pro server 6000",
  "rtx pro 6000": "rtx pro server 6000",
  "rtx pro server": "rtx pro server 6000",
  b200: "b200",
  b300: "b300",
  gb200: "b200",
};

/** All GPUs for a given vendor. */
export function getGPUsByVendor(vendor: string): GPUInfo[] {
  return Object.values(GPUDatabase).filter((g) => g.vendor === vendor);
}

/** All GPUs for a given use case. */
export function getGPUsByUseCase(useCase: string): GPUInfo[] {
  return Object.values(GPUDatabase).filter((g) => g.useCase === useCase);
}
