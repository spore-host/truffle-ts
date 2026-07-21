import { describe, it, expect } from "vitest";
import {
  ProcessorDatabase,
  VendorAliases,
  getProcessorsByVendor,
  getFamiliesByVendor,
  GPUDatabase,
  GPUAliases,
  getGPUsByVendor,
  getGPUsByUseCase,
  EFACapableFamilies,
  NetworkBandwidthTiers,
  NetworkAliases,
  getFamiliesByNetworkSpeed,
  isEFASupported,
  SizeCategories,
  getSizesForCategory,
  lookupApp,
} from "./index.js";

describe("processors", () => {
  it("has known code names with the right vendor/arch", () => {
    expect(ProcessorDatabase["sapphire rapids"]).toMatchObject({ vendor: "intel", architecture: "x86_64" });
    expect(ProcessorDatabase["genoa"]).toMatchObject({ vendor: "amd", architecture: "x86_64" });
    expect(ProcessorDatabase["graviton3"]).toMatchObject({ vendor: "aws", architecture: "arm64" });
  });

  it("resolves vendor aliases to canonical vendors", () => {
    expect(VendorAliases["graviton"]).toBe("aws");
    expect(VendorAliases["arm"]).toBe("aws");
    expect(VendorAliases["amazon"]).toBe("aws");
    expect(VendorAliases["intel"]).toBe("intel");
  });

  it("getFamiliesByVendor returns deduped families, sorted + stable", () => {
    const aws = getFamiliesByVendor("aws");
    expect(aws).toContain("c7g");
    expect(aws).toContain("r8g");
    expect(new Set(aws).size).toBe(aws.length); // deduped
    expect([...aws]).toEqual([...aws].sort()); // sorted
    expect(getProcessorsByVendor("intel").length).toBeGreaterThanOrEqual(5);
  });
});

describe("gpus", () => {
  it("maps GPUs to memory / families / exact instance types", () => {
    expect(GPUDatabase["h100"]).toMatchObject({ name: "H100", memoryGB: 80, families: ["p5"] });
    expect(GPUDatabase["h100"].instanceTypes).toContain("p5.48xlarge");
    expect(GPUDatabase["a100"].instanceTypes).toEqual(["p4d.24xlarge", "p4de.24xlarge"]);
  });

  it("resolves GPU aliases (incl. marketing spellings) to canonical keys", () => {
    expect(GPUAliases["a10"]).toBe("a10g");
    expect(GPUAliases["gb200"]).toBe("b200");
    expect(GPUAliases["rtx pro 6000"]).toBe("rtx pro server 6000");
    // Every alias target must exist in the database.
    for (const target of Object.values(GPUAliases)) {
      expect(GPUDatabase[target], `alias target ${target}`).toBeDefined();
    }
  });

  it("filters GPUs by vendor and use case", () => {
    expect(getGPUsByVendor("aws").map((g) => g.name)).toContain("Trainium");
    expect(getGPUsByUseCase("training").length).toBeGreaterThanOrEqual(4);
  });
});

describe("network", () => {
  it("lists a healthy number of EFA-capable families", () => {
    expect(EFACapableFamilies.length).toBeGreaterThanOrEqual(20);
    expect(isEFASupported("c7gn")).toBe(true);
    expect(isEFASupported("t3")).toBe(false);
  });

  it("bandwidth tiers accumulate downward (100g ⊆ families reaching ≥50g)", () => {
    const fast = getFamiliesByNetworkSpeed(100);
    const medium = getFamiliesByNetworkSpeed(50);
    expect(fast).toContain("p5");
    // Everything reaching 100 also appears when we ask for >=50.
    for (const f of fast) expect(medium).toContain(f);
  });

  it("every bandwidth tier has a positive maxBandwidthGbps and families", () => {
    for (const [speed, cap] of Object.entries(NetworkBandwidthTiers)) {
      expect(cap.maxBandwidthGbps, speed).toBeGreaterThan(0);
      expect(cap.families.length, speed).toBeGreaterThan(0);
    }
  });

  it("resolves network aliases", () => {
    expect(NetworkAliases["100g"]).toBe("100gbps");
    expect(NetworkAliases["lowlatency"]).toBe("efa");
    expect(NetworkAliases["ultranet"]).toBe("100gbps");
  });
});

describe("sizes", () => {
  it("maps categories to size suffixes", () => {
    expect(SizeCategories["medium"].sizes).toEqual(["large", "xlarge"]);
    expect(getSizesForCategory("large")).toEqual(["2xlarge", "4xlarge"]);
    expect(getSizesForCategory("nonsense")).toEqual([]);
  });
});

describe("apps", () => {
  it("looks up apps case-insensitively with families + minimums", () => {
    expect(lookupApp("ParaView")).toMatchObject({ name: "paraview", gpu: true, minVcpus: 4 });
    expect(lookupApp("igv")!.instanceFamilies).toContain("c7i");
    expect(lookupApp("unknown")).toBeUndefined();
  });
});
