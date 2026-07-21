// gen-catalog — regenerate src/data/instances.json from LIVE AWS data.
//
// Unlike scripts/seed-catalog.mjs (hand-curated specs), this pulls real specs
// from EC2 DescribeInstanceTypes and real on-demand $/hr from the Pricing API,
// for a CURATED set of instance-type families (every GPU family + common
// graviton/Intel/AMD). Read-only AWS: describe + pricing, never a launch.
//
// Usage:  AWS_PROFILE=<profile> node scripts/gen-catalog.mjs [--region us-east-1]
//
// Requires the AWS CLI on PATH and credentials for describe + pricing. Run
// out-of-band (it needs creds a browser can't have); commit the resulting JSON.
// The bundled catalog stays an approximate snapshot — record the date you ran it.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const region = (() => {
  const i = process.argv.indexOf("--region");
  return i >= 0 ? process.argv[i + 1] : "us-east-1";
})();

// The curated family set: derived from the families already in the committed
// catalog, so regeneration keeps the same coverage (every GPU family + common
// CPU families) without ballooning to all ~800 us-east-1 types.
const catalogPath = fileURLToPath(new URL("../src/data/instances.json", import.meta.url));
const existing = JSON.parse(readFileSync(catalogPath, "utf8"));
const families = [...new Set(existing.map((e) => e.instanceFamily))].sort();

function aws(args) {
  const out = execFileSync("aws", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

// 1. Enumerate the instance types in our families that actually exist in-region.
console.error(`Enumerating instance types for ${families.length} families in ${region}…`);
const describe = aws([
  "ec2", "describe-instance-types", "--region", region,
  "--filters", `Name=instance-type,Values=${families.map((f) => `${f}.*`).join(",")}`,
  "--output", "json",
]);

const toEntry = (it) => {
  const gpu = it.GpuInfo?.Gpus?.[0];
  const gpuCount = (it.GpuInfo?.Gpus ?? []).reduce((n, g) => n + (g.Count ?? 0), 0);
  const nested = (it.ProcessorInfo?.SupportedFeatures ?? []).includes("nested-virtualization");
  const e = {
    instanceType: it.InstanceType,
    instanceFamily: it.InstanceType.split(".")[0],
    vcpus: it.VCpuInfo.DefaultVCpus,
    physicalCores: it.VCpuInfo.DefaultCores,
    threadsPerCore: it.VCpuInfo.DefaultThreadsPerCore,
    memoryMib: it.MemoryInfo.SizeInMiB,
    architecture: it.ProcessorInfo.SupportedArchitectures.includes("arm64") ? "arm64" : "x86_64",
    nestedVirt: nested,
    onDemandPrice: 0, // filled below
  };
  if (gpu && gpuCount > 0) {
    e.gpus = gpuCount;
    e.gpuModel = gpu.Name;
    e.gpuManufacturer = (gpu.Manufacturer ?? "").toLowerCase() || undefined;
    e.gpuMemoryMib = (it.GpuInfo.TotalGpuMemoryInMiB ?? (gpu.MemoryInfo?.SizeInMiB ?? 0) * gpuCount) || undefined;
  }
  return e;
};

const entries = describe.InstanceTypes.map(toEntry);
console.error(`  got ${entries.length} instance types`);

// 2. Fetch real on-demand $/hr per type from the Pricing API (us-east-1 endpoint,
//    Linux/Shared/Used). Falls back to 0 (consumers estimate) if a type has no
//    price row. Pricing is served only from us-east-1 / ap-south-1.
console.error(`Fetching on-demand prices…`);
let priced = 0;
for (const e of entries) {
  try {
    const res = aws([
      "pricing", "get-products", "--region", "us-east-1", "--service-code", "AmazonEC2",
      "--filters",
      `Type=TERM_MATCH,Field=instanceType,Value=${e.instanceType}`,
      `Type=TERM_MATCH,Field=regionCode,Value=${region}`,
      `Type=TERM_MATCH,Field=operatingSystem,Value=Linux`,
      `Type=TERM_MATCH,Field=tenancy,Value=Shared`,
      `Type=TERM_MATCH,Field=capacitystatus,Value=Used`,
      `Type=TERM_MATCH,Field=preInstalledSw,Value=NA`,
      "--max-results", "1", "--output", "json",
    ]);
    const item = res.PriceList?.[0];
    if (item) {
      const prod = JSON.parse(item);
      const onDemand = prod.terms?.OnDemand ?? {};
      const dim = Object.values(onDemand)[0]?.priceDimensions ?? {};
      const usd = Object.values(dim)[0]?.pricePerUnit?.USD;
      if (usd) {
        e.onDemandPrice = Number(Number(usd).toFixed(4));
        priced++;
      }
    }
  } catch (err) {
    console.error(`  price lookup failed for ${e.instanceType}: ${err.message}`);
  }
}
console.error(`  priced ${priced}/${entries.length}`);

// 3. Preserve GPU instance types the live query didn't return (legacy families
//    like g3/p2/p3 or brand-new ones like p5e/p6e-gb200 not offered in this
//    region/account). The drift-invariant test requires every GPUDatabase type
//    to exist in the catalog, and dropping them would break GPU-name resolution
//    offline. Carry the prior entry forward, marked estimatedPrice so it's clear
//    it isn't live. Which types matter is read from src/metadata/gpus.ts.
const gpusSrc = readFileSync(fileURLToPath(new URL("../src/metadata/gpus.ts", import.meta.url)), "utf8");
const gpuTypes = new Set([...gpusSrc.matchAll(/"([a-z0-9]+[0-9][a-z0-9-]*\.[0-9a-z]+)"/g)].map((m) => m[1]));
const live = new Set(entries.map((e) => e.instanceType));
const priorByType = new Map(existing.map((e) => [e.instanceType, e]));
let carried = 0;
for (const t of gpuTypes) {
  if (live.has(t)) continue;
  const prior = priorByType.get(t);
  if (prior) {
    entries.push({ ...prior, estimatedPrice: true });
    carried++;
  }
}
if (carried) console.error(`  carried ${carried} GPU type(s) not offered in ${region} (marked estimatedPrice)`);

entries.sort((a, b) => (a.instanceType < b.instanceType ? -1 : 1));
writeFileSync(catalogPath, JSON.stringify(entries, null, 2) + "\n");
console.error(`Wrote ${entries.length} instance types → ${catalogPath}`);
console.error(`Remember to update CATALOG_AS_OF in src/data/catalog.ts to this month.`);
