// One-shot seed generator for src/data/instances.json — the bundled instance
// catalog. NOT run at build time; run manually (`node scripts/seed-catalog.mjs`)
// to (re)generate the committed snapshot. Hand-curated specs "as of 2026-01".
//
// This exists because the Go truffle tool has no `dump` command — instance specs
// come from live DescribeInstanceTypes. Until a live gen-catalog lands (roadmap),
// this seeds a representative catalog: every GPU family from the metadata plus
// common graviton/Intel/AMD CPU families across sizes.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// vCPU per size suffix (relative to "large" = 2 vCPU). Memory is family-specific.
const VCPU = { large: 2, xlarge: 4, "2xlarge": 8, "4xlarge": 16, "8xlarge": 32, "12xlarge": 48, "16xlarge": 64, "24xlarge": 96, "48xlarge": 192, "32xlarge": 128, "2xlarge_gpu": 8 };

// CPU families: [family, arch, memPerVcpuGiB, threadsPerCore, sizes]
const CPU = [
  ["m7i", "x86_64", 4, 2, ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]],
  ["c7i", "x86_64", 2, 2, ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]],
  ["r7i", "x86_64", 8, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["m6i", "x86_64", 4, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["c6i", "x86_64", 2, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["m7a", "x86_64", 4, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["c7a", "x86_64", 2, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["c6a", "x86_64", 2, 2, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["m7g", "arm64", 4, 1, ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]],
  ["c7g", "arm64", 2, 1, ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]],
  ["r7g", "arm64", 8, 1, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["r8g", "arm64", 8, 1, ["large", "xlarge", "2xlarge", "4xlarge"]],
  ["c7gn", "arm64", 2, 1, ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "16xlarge"]],
  ["hpc7g", "arm64", 2, 1, ["4xlarge", "8xlarge", "16xlarge"]],
  ["t3", "x86_64", 2, 2, ["micro", "small", "medium", "large", "xlarge", "2xlarge"]],
  ["t4g", "arm64", 2, 1, ["micro", "small", "medium", "large", "xlarge", "2xlarge"]],
];
const TSIZE = { micro: 0.5, small: 1, medium: 2, large: 2, xlarge: 4, "2xlarge": 8, "4xlarge": 16, "8xlarge": 32, "12xlarge": 48, "16xlarge": 64, "24xlarge": 96, "48xlarge": 192, "32xlarge": 128 };

// GPU instances: derived DIRECTLY from the GPUDatabase (mirrored here — keep in
// sync with src/metadata/gpus.ts) so EVERY exact instance type the metadata
// references exists in the catalog (the drift-invariant test enforces this).
// Specs are approximated from the size suffix — fine for an offline snapshot; a
// live gen-catalog will replace them. Non-GPU accelerators (Trainium/Inferentia)
// carry gpus:0 but still appear so their families resolve.
const GPU_DB = {
  h200: { model: "H200", mfr: "nvidia", gpuMemPer: 141, types: ["p5e.48xlarge"] },
  h100: { model: "H100", mfr: "nvidia", gpuMemPer: 80, types: ["p5.48xlarge"] },
  a100: { model: "A100", mfr: "nvidia", gpuMemPer: 40, types: ["p4d.24xlarge", "p4de.24xlarge"] },
  v100: { model: "V100", mfr: "nvidia", gpuMemPer: 16, types: ["p3.2xlarge", "p3.8xlarge", "p3.16xlarge", "p3dn.24xlarge"] },
  k80: { model: "K80", mfr: "nvidia", gpuMemPer: 12, types: ["p2.xlarge", "p2.8xlarge", "p2.16xlarge"] },
  m60: { model: "M60", mfr: "nvidia", gpuMemPer: 8, types: ["g3s.xlarge", "g3.4xlarge", "g3.8xlarge", "g3.16xlarge"] },
  a10g: { model: "A10G", mfr: "nvidia", gpuMemPer: 24, types: ["g5.xlarge", "g5.2xlarge", "g5.4xlarge", "g5.8xlarge", "g5.12xlarge", "g5.16xlarge", "g5.24xlarge", "g5.48xlarge"] },
  t4: { model: "T4", mfr: "nvidia", gpuMemPer: 16, types: ["g4dn.xlarge", "g4dn.2xlarge", "g4dn.4xlarge", "g4dn.8xlarge", "g4dn.12xlarge", "g4dn.16xlarge", "g4dn.metal"] },
  l4: { model: "L4", mfr: "nvidia", gpuMemPer: 24, types: ["g6.xlarge", "g6.2xlarge", "g6.4xlarge", "g6.8xlarge", "g6.12xlarge", "g6.16xlarge", "g6.24xlarge", "g6.48xlarge"] },
  l40s: { model: "L40S", mfr: "nvidia", gpuMemPer: 48, types: ["g6e.xlarge", "g6e.2xlarge", "g6e.4xlarge", "g6e.8xlarge", "g6e.12xlarge", "g6e.16xlarge", "g6e.24xlarge", "g6e.48xlarge"] },
  rtx6000: { model: "RTX PRO Server 6000", mfr: "nvidia", gpuMemPer: 96, types: ["g7e.2xlarge", "g7e.4xlarge", "g7e.8xlarge", "g7e.12xlarge", "g7e.24xlarge", "g7e.48xlarge"] },
  rtx4500: { model: "RTX PRO 4500", mfr: "nvidia", gpuMemPer: 32, types: ["g7.2xlarge", "g7.4xlarge", "g7.8xlarge", "g7.12xlarge", "g7.24xlarge", "g7.48xlarge"] },
  b200: { model: "B200", mfr: "nvidia", gpuMemPer: 179, types: ["p6-b200.48xlarge", "p6e-gb200.36xlarge"] },
  b300: { model: "B300", mfr: "nvidia", gpuMemPer: 268, types: ["p6-b300.48xlarge"] },
  radeon: { model: "Radeon Pro V520", mfr: "amd", gpuMemPer: 8, types: ["g4ad.xlarge", "g4ad.2xlarge", "g4ad.4xlarge", "g4ad.8xlarge", "g4ad.16xlarge"] },
  inferentia: { model: "", mfr: "", gpuMemPer: 0, types: ["inf1.xlarge", "inf1.2xlarge", "inf1.6xlarge", "inf1.24xlarge"] },
  inferentia2: { model: "", mfr: "", gpuMemPer: 0, types: ["inf2.xlarge", "inf2.8xlarge", "inf2.24xlarge", "inf2.48xlarge"] },
  trainium: { model: "", mfr: "", gpuMemPer: 0, types: ["trn1.2xlarge", "trn1.32xlarge", "trn1n.32xlarge"] },
};

// vCPU by size suffix for GPU instances (approximate; large accelerators scale up).
const GPU_VCPU = { xlarge: 4, "2xlarge": 8, "4xlarge": 16, "8xlarge": 32, "12xlarge": 48, "16xlarge": 64, "24xlarge": 96, "32xlarge": 128, "36xlarge": 144, "48xlarge": 192, metal: 96 };

const gpuFamily = (it) => it.split(".")[0];
// How many GPUs a size carries: heuristic — biggest size = full board count.
const GPU_COUNT_BY_SIZE = { xlarge: 1, "2xlarge": 1, "4xlarge": 1, "8xlarge": 1, "12xlarge": 4, "16xlarge": 8, "24xlarge": 4, "32xlarge": 16, "36xlarge": 72, "48xlarge": 8, metal: 8 };

const out = [];
for (const [family, arch, memPerVcpu, tpc, sizes] of CPU) {
  for (const size of sizes) {
    const vcpus = family === "t3" || family === "t4g" ? Math.max(1, Math.round(TSIZE[size] / (memPerVcpu / 2))) : (VCPU[size] ?? 2);
    const memGiB = family === "t3" || family === "t4g" ? TSIZE[size] : vcpus * memPerVcpu;
    out.push({
      instanceType: `${family}.${size}`, instanceFamily: family,
      vcpus, memoryMib: Math.round(memGiB * 1024), architecture: arch,
      threadsPerCore: tpc, nestedVirt: arch === "x86_64" && !["t3"].includes(family),
      onDemandPrice: 0, // filled from pricing below
    });
  }
}
const seenGpu = new Set();
for (const info of Object.values(GPU_DB)) {
  for (const it of info.types) {
    if (seenGpu.has(it)) continue;
    seenGpu.add(it);
    const size = it.split(".")[1];
    const vcpus = GPU_VCPU[size] ?? 8;
    const e = {
      instanceType: it, instanceFamily: gpuFamily(it), vcpus,
      memoryMib: vcpus * 8 * 1024, // GPU boxes are memory-rich (~8 GiB/vCPU)
      architecture: "x86_64", threadsPerCore: 2, nestedVirt: false, onDemandPrice: 0,
    };
    if (info.model) {
      const count = GPU_COUNT_BY_SIZE[size] ?? 1;
      e.gpus = count;
      e.gpuModel = info.model;
      e.gpuManufacturer = info.mfr;
      e.gpuMemoryMib = info.gpuMemPer * count * 1024;
    }
    out.push(e);
  }
}

// Price each entry with the same model as src/data/pricing.ts (exact table →
// family estimate). Inlined here so this script runs under plain node without a
// TS loader; keep in sync with pricing.ts (the runtime source of truth).
const basePriceLarge = { t2: 0.0928, t3: 0.0832, t3a: 0.0752, t4g: 0.0672, m5: 0.096, m5a: 0.086, m5n: 0.119, m6i: 0.096, m6a: 0.086, m7i: 0.1008, c5: 0.085, c5a: 0.077, c5n: 0.108, c6i: 0.085, c6a: 0.077, c7i: 0.0893, r5: 0.126, r5a: 0.113, r6i: 0.126, g4dn: 0.263, g5: 0.503, p3: 0.765, p4d: 0.6827 };
const sizeMultiplier = { nano: 0.0625, micro: 0.125, small: 0.25, medium: 0.5, large: 1.0, xlarge: 2.0, "2xlarge": 4.0, "4xlarge": 8.0, "8xlarge": 16.0, "12xlarge": 24.0, "16xlarge": 32.0, "24xlarge": 48.0, "48xlarge": 96.0, metal: 48.0 };
const EXACT = { "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328, "t4g.micro": 0.0084, "t4g.small": 0.0168, "t4g.medium": 0.0336, "t4g.large": 0.0672, "t4g.xlarge": 0.1344, "t4g.2xlarge": 0.2688, "m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384, "m5.4xlarge": 0.768, "m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384, "m6i.4xlarge": 0.768, "m7i.large": 0.1008, "m7i.xlarge": 0.2016, "m7i.2xlarge": 0.4032, "m7i.4xlarge": 0.8064, "m7g.large": 0.0816, "m7g.xlarge": 0.1632, "m7g.2xlarge": 0.3264, "m7g.4xlarge": 0.6528, "m7a.large": 0.11592, "m7a.xlarge": 0.23184, "m7a.2xlarge": 0.46368, "c5.large": 0.085, "c5.xlarge": 0.17, "c5.2xlarge": 0.34, "c5.4xlarge": 0.68, "c6i.large": 0.085, "c6i.xlarge": 0.17, "c6i.2xlarge": 0.34, "c6i.4xlarge": 0.68, "c7i.large": 0.0893, "c7i.xlarge": 0.1785, "c7i.2xlarge": 0.357, "c7i.4xlarge": 0.714, "c7g.large": 0.0725, "c7g.xlarge": 0.145, "c7g.2xlarge": 0.29, "c7g.4xlarge": 0.58, "c6a.large": 0.0765, "c6a.xlarge": 0.153, "c6a.2xlarge": 0.306, "c6a.4xlarge": 0.612, "r5.large": 0.126, "r5.xlarge": 0.252, "r5.2xlarge": 0.504, "r6i.large": 0.126, "r6i.xlarge": 0.252, "r6i.2xlarge": 0.504, "r7g.large": 0.10584, "r7g.xlarge": 0.21168, "r7g.2xlarge": 0.42336, "r8g.large": 0.11844, "r8g.xlarge": 0.23688, "r8g.2xlarge": 0.47376, "g4dn.xlarge": 0.526, "g4dn.2xlarge": 0.752, "g4dn.12xlarge": 3.912, "g5.xlarge": 1.006, "g5.2xlarge": 1.212, "g5.12xlarge": 5.672, "g5.48xlarge": 16.288, "g6.xlarge": 0.8048, "g6.12xlarge": 4.6016, "g6e.xlarge": 1.861, "p3.2xlarge": 3.06, "p3.8xlarge": 12.24, "p3.16xlarge": 24.48, "p4d.24xlarge": 32.7726, "p5.48xlarge": 98.32, "inf2.xlarge": 0.7582, "inf2.48xlarge": 12.98, "trn1.2xlarge": 1.3438, "trn1.32xlarge": 21.5 };
const priceOf = (it) => {
  if (EXACT[it] !== undefined) return EXACT[it];
  const [family, size] = it.split(".");
  return (basePriceLarge[family] ?? 0.1) * (sizeMultiplier[size] ?? 2.0);
};
for (const e of out) {
  e.onDemandPrice = Number(priceOf(e.instanceType).toFixed(4));
}

out.sort((a, b) => a.instanceType < b.instanceType ? -1 : 1);
const dest = fileURLToPath(new URL("../src/data/instances.json", import.meta.url));
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} instance types → ${dest}`);
