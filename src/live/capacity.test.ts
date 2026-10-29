// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EC2Client,
  DescribeCapacityReservationsCommand,
  DescribeCapacityBlockOfferingsCommand,
} from "@aws-sdk/client-ec2";
import {
  roundCapacityBlockDuration,
  humanizeHours,
  parseFee,
  sortOfferings,
  noOfferingsMessage,
  offeringWindow,
  sortCapacityReservations,
  sortCapacityBlocks,
  filterGPUReservations,
  summarizeCapacity,
  fetchCapacityReservations,
  fetchCapacityBlocks,
  fetchCapacityBlockOfferings,
  fanOutRegions,
  isCapacityBlockIneligible,
  type CapacityBlockOfferingResult,
  type CapacityReservationResult,
  type CapacityBlockResult,
} from "./capacity.js";
import { AwsLiveFinder } from "./live-finder.js";

afterEach(() => vi.restoreAllMocks());

// ── Ported verbatim from Go cmd/capacity_blocks_test.go ──────────────────────
describe("roundCapacityBlockDuration (TestRoundCapacityBlockDuration)", () => {
  const cases: [number, number | "error"][] = [
    [1, 24], [24, 24], [25, 48], [30, 48], [336, 336], [337, 504], [504, 504], [505, 672], [4368, 4368],
    [4369, "error"], [0, "error"],
  ];
  for (const [input, want] of cases) {
    it(`${input}h → ${want}`, () => {
      if (want === "error") expect(() => roundCapacityBlockDuration(input)).toThrow();
      else expect(roundCapacityBlockDuration(input)).toBe(want);
    });
  }
});

describe("humanizeHours (TestHumanizeHours)", () => {
  it("days and weeks", () => {
    const cases: [number, string][] = [[24, "1 day"], [48, "2 days"], [72, "3 days"], [168, "1 week"], [336, "2 weeks"], [504, "3 weeks"]];
    for (const [h, want] of cases) expect(humanizeHours(h)).toBe(want);
  });
});

describe("parseFee (TestParseFee)", () => {
  it("parses fees and sorts unparseable ones last", () => {
    expect(parseFee("830.5900")).toBe(830.59);
    expect(parseFee("  264.17 ")).toBe(264.17);
    expect(parseFee("0")).toBe(0);
    for (const bad of ["", "n/a", "free"]) expect(parseFee(bad)).toBe(Infinity);
  });
});

describe("sortOfferings (TestSortOfferings)", () => {
  const mk = (offeringId: string, startDate: string, upfrontFee: string) =>
    ({ offeringId, startDate, upfrontFee }) as CapacityBlockOfferingResult;
  const cheapLate = mk("cb-cheap", "2026-06-19T11:30:00Z", "100.00");
  const midEarly = mk("cb-mid", "2026-06-18T11:30:00Z", "500.00");
  const dearEarly = mk("cb-dear", "2026-06-18T11:30:00Z", "900.00");
  it("price = cheapest first", () => {
    expect(sortOfferings([dearEarly, cheapLate, midEarly], "price").map((o) => o.offeringId)).toEqual(["cb-cheap", "cb-mid", "cb-dear"]);
  });
  it("start = soonest first, fee breaks ties", () => {
    expect(sortOfferings([dearEarly, cheapLate, midEarly], "start").map((o) => o.offeringId)).toEqual(["cb-mid", "cb-dear", "cb-cheap"]);
  });
});

describe("noOfferingsMessage (TestNoOfferingsMessage, #109)", () => {
  it("names the count and suggests the retry", () => {
    const got = noOfferingsMessage("p5.48xlarge", 8, 24, ["us-east-1"]);
    for (const want of ["8 × p5.48xlarge", "us-east-1", "24h", "a count of 1"]) expect(got).toContain(want);
  });
  it("no retry hint at count 1", () => {
    const got = noOfferingsMessage("p5.48xlarge", 1, 24, ["us-east-1"]);
    expect(got).not.toContain("count of 1");
    expect(got).toContain("1 × p5.48xlarge");
  });
  it("summarizes a wide region fan-out", () => {
    expect(noOfferingsMessage("p5.48xlarge", 8, 24, ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1"])).toContain("5 regions");
    expect(noOfferingsMessage("p5.48xlarge", 8, 24, ["us-east-1", "us-west-2"])).toContain("us-east-1, us-west-2");
    expect(noOfferingsMessage("p5.48xlarge", 8, 24, [])).toContain("any enabled region");
  });
});

describe("offeringWindow (#69)", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  it("defaults to now → now + duration + 1 day", () => {
    expect(offeringWindow(24, { now })).toEqual({ startAfter: "2026-10-29T12:00:00Z", endBy: "2026-10-31T12:00:00Z" });
  });
  it("a start date covers that UTC day + duration + 1 day", () => {
    expect(offeringWindow(48, { startDate: "2026-11-02", now })).toEqual({
      startAfter: "2026-11-02T00:00:00Z",
      endBy: "2026-11-05T00:00:00Z",
    });
  });
  it("explicit bounds win, and a bad date is refused", () => {
    expect(offeringWindow(24, { startAfter: "A", endBy: "B", now })).toEqual({ startAfter: "A", endBy: "B" });
    expect(() => offeringWindow(24, { startDate: "11/02/2026" })).toThrow(/YYYY-MM-DD/);
  });
});

// ── Ported from Go cmd/az_order_test.go TestSortCapacity_DeterministicAcrossAZs ──
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("capacity sorts are deterministic across AZs (#217)", () => {
  it("reservations", () => {
    const res = [
      { reservationId: "cr-2", instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "us-east-1a", availableCapacity: 2 },
      { reservationId: "cr-1", instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "us-east-1b", availableCapacity: 2 },
      { reservationId: "cr-3", instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "us-east-1b", availableCapacity: 2 },
      { reservationId: "cr-0", instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "us-east-1a", availableCapacity: 1 },
    ] as CapacityReservationResult[];
    for (let run = 0; run < 50; run++) expect(sortCapacityReservations(shuffled(res, run + 217))).toEqual(res);
  });
  it("blocks", () => {
    const blocks = [
      { capacityBlockId: "cb-2", instanceType: "p5.48xlarge", availabilityZone: "us-east-1a", startDate: "2026-10-20" },
      { capacityBlockId: "cb-1", instanceType: "p5.48xlarge", availabilityZone: "us-east-1b", startDate: "2026-10-20" },
      { capacityBlockId: "cb-3", instanceType: "p5.48xlarge", availabilityZone: "us-east-1b", startDate: "2026-10-20" },
      { capacityBlockId: "cb-0", instanceType: "p5.48xlarge", availabilityZone: "us-east-1a", startDate: "2026-10-21" },
    ] as CapacityBlockResult[];
    for (let run = 0; run < 50; run++) expect(sortCapacityBlocks(shuffled(blocks, run + 217))).toEqual(blocks);
  });
});

describe("filterGPUReservations / summarizeCapacity (Go helpers_test.go)", () => {
  it("detects GPU families by prefix", () => {
    for (const t of ["p5.48xlarge", "g6e.xlarge", "trn1n.32xlarge", "inf2.xlarge"]) expect(filterGPUReservations([{ instanceType: t }]), t).toHaveLength(1);
    for (const t of ["m5.large", "c6i.large", "r7g.xlarge", "t3.micro", "i4i.large"]) expect(filterGPUReservations([{ instanceType: t }]), t).toHaveLength(0);
  });
  it("summarizes utilization", () => {
    const rs = [
      { instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "a", totalCapacity: 4, availableCapacity: 1, usedCapacity: 3, state: "active" },
      { instanceType: "g5.xlarge", region: "us-west-2", availabilityZone: "b", totalCapacity: 4, availableCapacity: 3, usedCapacity: 1, state: "pending" },
    ] as CapacityReservationResult[];
    expect(summarizeCapacity(rs)).toEqual({
      totalReservations: 2, activeReservations: 1, instanceTypes: 2, regions: 2, availabilityZones: 2,
      totalCapacity: 8, availableCapacity: 4, usedCapacity: 4, utilizationPercent: 50,
    });
    expect(summarizeCapacity([]).utilizationPercent).toBe(0);
  });
});

// ── The AWS calls ─────────────────────────────────────────────────────────────
function stubEc2(handler: (cmd: any, region: string) => any) {
  const sent: { cmd: any; region: string }[] = [];
  vi.spyOn(EC2Client.prototype, "send").mockImplementation(async function (this: any, cmd: any) {
    const r = this.config.region;
    const region: string = typeof r === "function" ? await r() : r;
    sent.push({ cmd, region });
    return handler(cmd, region);
  } as any);
  return sent;
}

describe("fetchCapacityReservations (Go getRegionCapacityReservations)", () => {
  it("filters server-side by type and state, and drops expired/unavailable client-side", async () => {
    const sent = stubEc2(() => ({
      CapacityReservations: [
        { CapacityReservationId: "cr-a", InstanceType: "p5.48xlarge", AvailabilityZone: "us-east-1a", TotalInstanceCount: 4, AvailableInstanceCount: 1, State: "active", Tags: [{ Key: "team", Value: "ml" }], EndDate: new Date("2026-11-01T00:00:00Z") },
        { CapacityReservationId: "cr-b", InstanceType: "p5.48xlarge", TotalInstanceCount: 2, AvailableInstanceCount: 0, State: "active" },
        { CapacityReservationId: "cr-c", InstanceType: "p5.48xlarge", TotalInstanceCount: 2, AvailableInstanceCount: 2, State: "expired" },
      ],
    }));
    const out = await fetchCapacityReservations(new EC2Client({ region: "us-east-1" }), "us-east-1", {
      instanceTypes: ["p5.48xlarge"],
      onlyActive: true,
      onlyAvailable: true,
    });
    expect(sent[0].cmd).toBeInstanceOf(DescribeCapacityReservationsCommand);
    expect(sent[0].cmd.input.Filters).toEqual([
      { Name: "instance-type", Values: ["p5.48xlarge"] },
      { Name: "state", Values: ["active"] },
    ]);
    expect(out).toEqual([
      {
        reservationId: "cr-a", instanceType: "p5.48xlarge", region: "us-east-1", availabilityZone: "us-east-1a",
        totalCapacity: 4, availableCapacity: 1, usedCapacity: 3, state: "active", tenancy: "", ebsOptimized: false,
        platform: "", endDate: "2026-11-01T00:00:00Z", tags: ["team=ml"],
      },
    ]);
  });
  it("applies minCapacity and keeps expired with includeExpired", async () => {
    stubEc2(() => ({
      CapacityReservations: [
        { CapacityReservationId: "cr-a", AvailableInstanceCount: 1, State: "active" },
        { CapacityReservationId: "cr-c", AvailableInstanceCount: 5, State: "expired" },
      ],
    }));
    const c = new EC2Client({ region: "us-east-1" });
    expect((await fetchCapacityReservations(c, "us-east-1", { minCapacity: 2 })).map((r) => r.reservationId)).toEqual([]);
    expect((await fetchCapacityReservations(c, "us-east-1", { minCapacity: 2, includeExpired: true })).map((r) => r.reservationId)).toEqual(["cr-c"]);
  });
});

describe("fetchCapacityBlocks (Go getRegionCapacityBlocks)", () => {
  it("asks for capacity-block reservations and computes the duration", async () => {
    const sent = stubEc2(() => ({
      CapacityReservations: [
        { CapacityReservationId: "cb-1", InstanceType: "p5.48xlarge", TotalInstanceCount: 1, StartDate: new Date("2026-11-01T11:30:00Z"), EndDate: new Date("2026-11-02T11:30:00Z"), State: "scheduled" },
        { CapacityReservationId: "cb-2", InstanceType: "p5.48xlarge", StartDate: new Date("2026-11-01T11:30:00Z"), EndDate: new Date("2026-11-08T11:30:00Z"), State: "active" },
      ],
    }));
    const out = await fetchCapacityBlocks(new EC2Client({ region: "us-west-2" }), "us-west-2", { onlyActive: true, maxDurationHours: 48 });
    expect(sent[0].cmd.input.Filters).toEqual([
      { Name: "capacity-reservation-type", Values: ["capacity-block"] },
      { Name: "state", Values: ["active", "scheduled"] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ capacityBlockId: "cb-1", durationHours: 24, ultraClusterPlacement: true, region: "us-west-2" });
  });
});

describe("fetchCapacityBlockOfferings (Go getRegionCapacityBlockOfferings)", () => {
  it("sends the window and count, defaulting the count to 1", async () => {
    const sent = stubEc2(() => ({
      CapacityBlockOfferings: [
        { CapacityBlockOfferingId: "cbo-1", InstanceType: "p5.48xlarge", InstanceCount: 1, AvailabilityZone: "us-west-2a", StartDate: new Date("2026-11-01T11:30:00Z"), EndDate: new Date("2026-11-02T11:30:00Z"), CapacityBlockDurationHours: 24, UpfrontFee: "830.5900", CurrencyCode: "USD", Tenancy: "default" },
      ],
    }));
    const out = await fetchCapacityBlockOfferings(new EC2Client({ region: "us-west-2" }), "us-west-2", {
      instanceType: "p5.48xlarge",
      durationHours: 24,
      startAfter: "2026-10-29T00:00:00Z",
      endBy: "2026-10-31T00:00:00Z",
    });
    expect(sent[0].cmd).toBeInstanceOf(DescribeCapacityBlockOfferingsCommand);
    expect(sent[0].cmd.input).toMatchObject({ CapacityDurationHours: 24, InstanceType: "p5.48xlarge", InstanceCount: 1 });
    expect(sent[0].cmd.input.StartDateRange.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(out[0]).toEqual({
      offeringId: "cbo-1", instanceType: "p5.48xlarge", instanceCount: 1, availabilityZone: "us-west-2a", region: "us-west-2",
      startDate: "2026-11-01T11:30:00Z", endDate: "2026-11-02T11:30:00Z", durationHours: 24, upfrontFee: "830.5900",
      currencyCode: "USD", tenancy: "default",
    });
  });
});

describe("fanOutRegions: a failed query is never 'nothing found' (Go #63/#109/#110)", () => {
  it("throws when every region fails", async () => {
    await expect(fanOutRegions(["a", "b"], async () => { throw new Error("AccessDenied"); }, "capacity reservation")).rejects.toThrow(
      /all 2 capacity reservation region queries failed: region a: AccessDenied; region b: AccessDenied/,
    );
  });
  it("returns partial results with the failed regions named", async () => {
    const r = await fanOutRegions(["us-west-2", "us-east-1"], async (region) => {
      if (region === "us-east-1") throw new Error("throttled");
      return [region];
    }, "x");
    expect(r).toEqual({ results: ["us-west-2"], regionErrors: [{ region: "us-east-1", error: "throttled" }] });
  });
  it("says 'not eligible' when every region says so (#110)", async () => {
    const ineligible = Object.assign(new Error("The instance type c7i.4xlarge is not supported for Capacity Blocks"), { name: "InvalidParameterValue" });
    expect(isCapacityBlockIneligible(ineligible)).toBe(true);
    expect(isCapacityBlockIneligible(new Error("AccessDenied"))).toBe(false);
    await expect(
      fanOutRegions(["a"], async () => { throw ineligible; }, "y", (e) => (isCapacityBlockIneligible(e) ? "instance type not eligible for Capacity Blocks" : undefined)),
    ).rejects.toThrow(/^instance type not eligible for Capacity Blocks in all 1 queried region/);
  });
});

describe("AwsLiveFinder capacity methods", () => {
  it("getCapacityBlockOfferings rounds the duration up, says so, and sorts by price", async () => {
    const sent = stubEc2((_cmd, region) => ({
      CapacityBlockOfferings: [
        { CapacityBlockOfferingId: `cbo-${region}`, UpfrontFee: region === "us-west-2" ? "100" : "900", StartDate: new Date("2026-11-01T11:30:00Z") },
      ],
    }));
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    const r = await f.getCapacityBlockOfferings({ instanceType: "p5.48xlarge", durationHours: 25, now: new Date("2026-10-29T00:00:00Z") });
    expect(r.durationHours).toBe(48);
    expect(r.durationRoundedFrom).toBe(25);
    expect(sent.every((s) => s.cmd.input.CapacityDurationHours === 48)).toBe(true);
    // Window uses the ROUNDED duration: now + 48h + 1 day cushion.
    expect(sent[0].cmd.input.EndDateRange.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(r.results.map((o) => o.offeringId)).toEqual(["cbo-us-west-2", "cbo-us-east-1"]);
  });
  it("getCapacityReservations sorts and reports a failed region", async () => {
    stubEc2((_cmd, region) => {
      if (region === "eu-west-1") throw new Error("boom");
      return { CapacityReservations: [{ CapacityReservationId: `cr-${region}`, AvailableInstanceCount: region === "us-west-2" ? 5 : 1, State: "active" }] };
    });
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2", "eu-west-1"] });
    const r = await f.getCapacityReservations({});
    expect(r.results.map((x) => x.reservationId)).toEqual(["cr-us-west-2", "cr-us-east-1"]);
    expect(r.regionErrors).toEqual([{ region: "eu-west-1", error: "boom" }]);
  });
  it("getCapacityBlocks sorts soonest first", async () => {
    stubEc2((_cmd, region) => ({
      CapacityReservations: [{ CapacityReservationId: `cb-${region}`, StartDate: new Date(region === "us-east-1" ? "2026-11-05T11:30:00Z" : "2026-11-01T11:30:00Z") }],
    }));
    const f = new AwsLiveFinder({ regions: ["us-east-1", "us-west-2"] });
    expect((await f.getCapacityBlocks()).results.map((b) => b.capacityBlockId)).toEqual(["cb-us-west-2", "cb-us-east-1"]);
  });
});
