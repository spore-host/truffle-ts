// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EC2Client,
  GetSpotPlacementScoresCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeCapacityBlockOfferingsCommand,
} from "@aws-sdk/client-ec2";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { PricingClient } from "@aws-sdk/client-pricing";
import {
  obtainability,
  obtainabilityVerdict,
  instanceHeadroom,
  bestSpotPlacement,
  sortSpotPlacements,
  type Obtainability,
} from "./obtainability.js";
import { AwsLiveFinder } from "./live-finder.js";

afterEach(() => vi.restoreAllMocks());

type Handler = (cmd: any) => any;

/** Default EC2 world for p5.48xlarge in us-east-1; override per command class. */
function world(over: Map<unknown, Handler> = new Map()) {
  const sent: any[] = [];
  vi.spyOn(EC2Client.prototype, "send").mockImplementation((async (cmd: any) => {
    sent.push(cmd);
    for (const [cls, h] of over) if (cmd instanceof (cls as any)) return h(cmd);
    if (cmd instanceof GetSpotPlacementScoresCommand) {
      return { SpotPlacementScores: [{ AvailabilityZoneId: "use1-az1", Score: 3 }, { AvailabilityZoneId: "use1-az2", Score: 7 }, { AvailabilityZoneId: "use1-az9", Score: 7 }] };
    }
    if (cmd instanceof DescribeAvailabilityZonesCommand) {
      return { AvailabilityZones: [1, 2, 3, 4, 5, 6].map((n) => ({ ZoneId: `use1-az${n}`, ZoneName: `us-east-1${"abcdef"[n - 1]}` })) };
    }
    if (cmd instanceof DescribeInstanceTypeOfferingsCommand) {
      return { InstanceTypeOfferings: ["us-east-1b", "us-east-1a", "us-east-1b"].map((Location) => ({ InstanceType: "p5.48xlarge", Location })) };
    }
    if (cmd instanceof DescribeInstanceTypesCommand) return { InstanceTypes: [{ InstanceType: "p5.48xlarge", VCpuInfo: { DefaultVCpus: 192 } }] };
    if (cmd instanceof DescribeInstancesCommand) {
      return { Reservations: [{ Instances: [
        { InstanceType: "p5.48xlarge", CpuOptions: { CoreCount: 96, ThreadsPerCore: 2 } },
        { InstanceType: "p5.48xlarge", InstanceLifecycle: "spot", CpuOptions: { CoreCount: 96, ThreadsPerCore: 2 } },
      ] }] };
    }
    if (cmd instanceof DescribeCapacityBlockOfferingsCommand) return { CapacityBlockOfferings: [{ CapacityBlockOfferingId: "a" }, { CapacityBlockOfferingId: "b" }] };
    return {};
  }) as any);
  return sent;
}

function quotas(byCode: Record<string, number | Error>) {
  vi.spyOn(ServiceQuotasClient.prototype, "send").mockImplementation((async (cmd: any) => {
    const v = byCode[cmd.input.QuotaCode];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error("NoSuchResourceException");
    return { Quota: { Value: v } };
  }) as any);
}

const clients = (pricing = false) => ({
  ec2: new EC2Client({ region: "us-east-1" }),
  serviceQuotas: new ServiceQuotasClient({ region: "us-east-1" }),
  ...(pricing ? { pricing: new PricingClient({ region: "us-east-1" }) } : {}),
});

describe("obtainability: every signal (Go Obtainability, #108)", () => {
  it("collects spot scores, AZ footprint, headroom, vCPUs, blocks and price", async () => {
    const sent = world();
    quotas({ "L-417A185B": 576, "L-1216C47A": 64 });
    vi.spyOn(PricingClient.prototype, "send").mockResolvedValue({
      PriceList: [JSON.stringify({ terms: { OnDemand: { a: { priceDimensions: { b: { pricePerUnit: { USD: "55.04" } } } } } } })],
    } as never);
    const o = await obtainability(clients(true), "p5.48xlarge", "us-east-1");
    expect(o.spotPlacements).toEqual([
      { az: "us-east-1b", azId: "use1-az2", score: 7 },
      { az: "use1-az9", azId: "use1-az9", score: 7 }, // unmapped ID kept, not dropped
      { az: "us-east-1a", azId: "use1-az1", score: 3 },
    ]);
    expect(o.offeredAZs).toEqual(["us-east-1a", "us-east-1b"]); // deduped, zone order
    expect(o.totalAZs).toBe(6);
    // 576 - 192 on-demand vCPUs; the running SPOT p5 doesn't count (Go #132).
    expect(o.onDemandQuotaHeadroom).toBe(384);
    expect(o.quotaFamily).toBe("P");
    expect(o.quotaCode).toBe("L-417A185B");
    expect(o.vcpusPerInstance).toBe(192);
    expect(instanceHeadroom(o)).toBe(2);
    expect(o.capacityBlockOfferings).toBe(2);
    expect(o.capacityBlockWindowHours).toBe(24);
    expect(o.onDemandPrice).toBe(55.04);
    expect(o.onDemandPriceOrigin).toEqual({ source: "live" });
    expect(o.warnings).toEqual([]);
    expect(obtainabilityVerdict(o)).toEqual({ concerns: [], summary: "no blocking signals found" });

    // The three load-bearing GetSpotPlacementScores parameters, and count 1 / 24h for blocks.
    const sps = sent.find((c) => c instanceof GetSpotPlacementScoresCommand);
    expect(sps!.input).toEqual({
      InstanceTypes: ["p5.48xlarge"], RegionNames: ["us-east-1"], SingleAvailabilityZone: true, TargetCapacity: 1, TargetCapacityUnitType: "units",
    });
    const cbo = sent.find((c) => c instanceof DescribeCapacityBlockOfferingsCommand);
    expect(cbo!.input).toMatchObject({ InstanceType: "p5.48xlarge", InstanceCount: 1, CapacityDurationHours: 24 });
  });

  it("refuses an empty type or region — the only hard errors", async () => {
    await expect(obtainability(clients(), " ", "us-east-1")).rejects.toThrow(/instanceType is required/);
    await expect(obtainability(clients(), "p5.48xlarge", "")).rejects.toThrow(/region is required/);
  });
});

describe("a failed signal is a warning, never a good (or bad) reading (#63)", () => {
  it("an SCP-denied GetSpotPlacementScores is a warning, and not a spot concern", async () => {
    world(new Map([[GetSpotPlacementScoresCommand, () => { throw Object.assign(new Error("denied by SCP"), { name: "UnauthorizedOperation" }); }]]));
    quotas({ "L-417A185B": 576 });
    const o = await obtainability(clients(), "p5.48xlarge", "us-east-1");
    expect(o.spotPlacements).toEqual([]);
    expect(o.warnings).toContain("spot placement scores unavailable: UnauthorizedOperation: denied by SCP");
    expect(obtainabilityVerdict(o).concerns).not.toContain("spot");
  });

  it("an UNREADABLE quota is unknown, not 'quota is 0' (the bug filed as truffle#271)", async () => {
    world();
    // Every quota readable except the one that matters: P.
    quotas({ "L-1216C47A": 64, "L-417A185B": Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }) });
    const o = await obtainability(clients(), "p5.48xlarge", "us-east-1");
    expect(o.onDemandQuotaHeadroom).toBeUndefined();
    expect(o.warnings).toContain(
      "quota headroom unavailable: the On-Demand P vCPU quota (L-417A185B) could not be read — limit unknown, not zero",
    );
    expect(obtainabilityVerdict(o).concerns).not.toContain("quota");
  });

  it("a failed AZ lookup is unknown, not 'not offered in this region'", async () => {
    world(new Map([[DescribeInstanceTypeOfferingsCommand, () => { throw new Error("throttled"); }]]));
    quotas({ "L-417A185B": 576 });
    const o = await obtainability(clients(), "p5.48xlarge", "us-east-1");
    expect(o.offeredAZs).toBeUndefined();
    expect(o.warnings).toContain("offered AZs unavailable: throttled");
    expect(obtainabilityVerdict(o).concerns).not.toContain("azs");
  });

  it("an ineligible Capacity Block type says so", async () => {
    world(new Map([[DescribeCapacityBlockOfferingsCommand, () => { throw Object.assign(new Error("m7i.large is not supported for Capacity Blocks"), { name: "InvalidParameterValue" }); }]]));
    quotas({ "L-1216C47A": 64 });
    const o = await obtainability(clients(), "m7i.large", "us-east-1");
    expect(o.capacityBlockOfferings).toBeUndefined();
    expect(o.warnings.some((w) => w.startsWith("capacity block offerings unavailable: instance type not eligible for Capacity Blocks"))).toBe(true);
  });

  it("uses the 8-family quota table, where Go's `available` knows only P/G/Standard", async () => {
    world();
    quotas({ "L-2C3B7624": 0 });
    const o = await obtainability(clients(), "trn1.32xlarge", "us-east-1");
    expect(o.quotaFamily).toBe("Trn");
    expect(o.quotaCode).toBe("L-2C3B7624");
    expect(o.onDemandQuotaHeadroom).toBe(0);
    expect(obtainabilityVerdict(o).concerns).toContain("quota");
  });
});

describe("obtainabilityVerdict (Go printObtainability concerns)", () => {
  const base = (over: Partial<Obtainability>): Obtainability => ({
    instanceType: "p6-b200.48xlarge", region: "us-east-1", spotPlacements: [], offeredAZs: ["us-east-1a", "us-east-1b"],
    totalAZs: 6, quotaFamily: "P", quotaCode: "L-417A185B", warnings: [], ...over,
  });
  it("flags a low spot score, a single-AZ footprint, and no headroom", () => {
    const o = base({
      spotPlacements: [{ az: "us-east-1a", score: 1 }],
      offeredAZs: ["us-east-1a"],
      onDemandQuotaHeadroom: 0,
    });
    expect(obtainabilityVerdict(o)).toEqual({
      concerns: ["spot", "azs", "quota"],
      summary: "low obtainability (spot, azs, quota); consider `lagotto watch p6-b200.48xlarge`",
    });
  });
  it("headroom for zero whole instances is a quota concern; one AZ in a one-AZ region is not an AZ concern", () => {
    expect(obtainabilityVerdict(base({ onDemandQuotaHeadroom: 100, vcpusPerInstance: 192 })).concerns).toEqual(["quota"]);
    expect(obtainabilityVerdict(base({ offeredAZs: ["x"], totalAZs: 1 })).concerns).toEqual([]);
    expect(obtainabilityVerdict(base({ offeredAZs: [] })).concerns).toEqual(["azs"]);
    expect(obtainabilityVerdict(base({ spotPlacements: [{ az: "a", score: 4 }] })).concerns).toEqual([]);
  });
  it("helpers", () => {
    expect(bestSpotPlacement(base({}))).toBeUndefined();
    expect(instanceHeadroom({ onDemandQuotaHeadroom: 5 })).toBeUndefined();
    expect(sortSpotPlacements([{ az: "b", score: 5 }, { az: "a", score: 5 }, { az: "c", score: 9 }]).map((p) => p.az)).toEqual(["c", "a", "b"]);
  });
});

describe("AwsLiveFinder.getObtainability", () => {
  it("runs against the given region with a static-labelled price when the Price List fails", async () => {
    world();
    quotas({ "L-1216C47A": 64 });
    vi.spyOn(PricingClient.prototype, "send").mockRejectedValue(new Error("no creds") as never);
    const f = new AwsLiveFinder({ regions: "us-east-1", serviceQuotasClientFor: (r) => new ServiceQuotasClient({ region: r }) });
    const o = await f.getObtainability("t3.large");
    expect(o.region).toBe("us-east-1");
    expect(o.onDemandPrice).toBe(0.0832);
    expect(o.onDemandPriceOrigin).toMatchObject({ source: "static", reason: "live Price List failed: no creds" });
  });
});
