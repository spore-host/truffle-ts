// Match explanation — port of Go pkg/find/result.go ExplainMatch. Given a result
// instance and the query that produced it, return human-readable reasons it
// matched (processor/vendor/GPU/size/vCPU/memory/arch/EFA/network).

import {
  ProcessorDatabase,
  GPUDatabase,
  NetworkBandwidthTiers,
  getSizesForCategory,
  isEFASupported,
} from "../metadata/index.js";
import type { InstanceType } from "./types.js";
import type { ParsedQuery } from "./parser.js";
import { extractFamily } from "./filter.js";

/** Annotate why `it` matched `query`, in the Go phrasing/order. */
export function explainMatch(it: InstanceType, query: ParsedQuery): string[] {
  const reasons: string[] = [];
  const family = extractFamily(it.instanceType);

  // Processor (first family hit wins).
  for (const proc of query.processors) {
    const info = ProcessorDatabase[proc];
    if (info?.families.includes(family)) {
      reasons.push(`Processor: ${info.codeName} (${info.vendor} ${info.generation})`);
      break;
    }
  }

  // Vendor.
  outer: for (const vendor of query.vendors) {
    for (const info of Object.values(ProcessorDatabase)) {
      if (info.vendor === vendor && info.families.includes(family)) {
        reasons.push(`Vendor: ${vendor}`);
        break outer;
      }
    }
  }

  // GPU: exact instance-type match, else family match.
  for (const gpu of query.gpus) {
    const info = GPUDatabase[gpu];
    if (!info) continue;
    if (info.instanceTypes?.includes(it.instanceType)) {
      reasons.push(`GPU: ${info.name} (${info.memoryGB} GB, ${info.useCase})`);
      break;
    }
    if (info.families.includes(family)) {
      reasons.push(`GPU family: ${info.name} (${info.useCase})`);
      break;
    }
  }

  // Size.
  for (const size of query.sizes) {
    if (getSizesForCategory(size).some((s) => it.instanceType.endsWith("." + s))) {
      reasons.push(`Size: ${size}`);
      break;
    }
  }

  if (query.minVcpu > 0 && it.vcpus >= query.minVcpu) {
    reasons.push(`vCPUs: ${it.vcpus} >= ${query.minVcpu}`);
  }

  if (query.minMemory > 0) {
    const memGiB = it.memoryMib / 1024;
    if (memGiB >= query.minMemory) {
      reasons.push(`Memory: ${Math.round(memGiB)} GiB >= ${Math.round(query.minMemory)} GiB`);
    }
  }

  if (query.architecture !== "" && it.architecture.toLowerCase() === query.architecture.toLowerCase()) {
    reasons.push(`Architecture: ${it.architecture}`);
  }

  if (query.requireEfa && isEFASupported(family)) {
    reasons.push("Network: EFA supported");
  }

  if (query.minNetworkGbps > 0) {
    // First tier (sorted for stable output) whose families include this one.
    for (const speed of Object.keys(NetworkBandwidthTiers).sort()) {
      const cap = NetworkBandwidthTiers[speed];
      if (cap.maxBandwidthGbps >= query.minNetworkGbps && cap.families.includes(family)) {
        reasons.push(`Network: ${query.minNetworkGbps}+ Gbps (supports ${speed})`);
        break;
      }
    }
  }

  return reasons;
}
