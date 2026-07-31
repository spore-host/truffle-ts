// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { ServiceQuotasClient } from "@aws-sdk/client-service-quotas";
import { EC2Client } from "@aws-sdk/client-ec2";
import {
  canLaunch,
  fetchQuotas,
  fetchUsage,
  letterPrefix,
  quotaFamilyFor,
  quotaIncreaseCommand,
  vcpusForSize,
  QUOTA_CODES,
  QUOTA_FAMILIES,
} from "./quotas.js";
import type { QuotaInfo } from "../core/finder.js";
import type { InstanceType } from "../core/types.js";

afterEach(() => vi.restoreAllMocks());

const inst = (instanceType: string, vcpus: number): InstanceType =>
  ({ instanceType, instanceFamily: instanceType.split(".")[0], vcpus, memoryMib: 1024, architecture: "x86_64" }) as InstanceType;

describe("letterPrefix", () => {
  it("returns the leading lowercase-letter run", () => {
    expect(letterPrefix("m7i.large")).toBe("m");
    expect(letterPrefix("dl2q.24xlarge")).toBe("dl");
    expect(letterPrefix("trn1.32xlarge")).toBe("trn");
    expect(letterPrefix("vt1.3xlarge")).toBe("vt");
  });
  it("stops at the first non-letter", () => {
    expect(letterPrefix("p5.48xlarge")).toBe("p");
    expect(letterPrefix("g4dn.xlarge")).toBe("g"); // digit ends the run, not 'dn'
  });
});

describe("quotaFamilyFor", () => {
  it("maps accelerator families by their full letter prefix", () => {
    // Go #64: a startsWith-style match misfiles these under a single letter.
    expect(quotaFamilyFor("dl1.24xlarge")).toBe("DL");
    expect(quotaFamilyFor("dl2q.24xlarge")).toBe("DL");
    expect(quotaFamilyFor("trn1.32xlarge")).toBe("Trn");
    expect(quotaFamilyFor("inf2.48xlarge")).toBe("Inf");
  });

  it("does NOT misfile dl/trn/inf under the single-letter families", () => {
    // The regression guard: "dl1" starts with "d" (Standard) and "trn1" with "t"
    // (Standard); if either resolved that way the quota check would consult the
    // wrong limit entirely.
    expect(quotaFamilyFor("dl1.24xlarge")).not.toBe("Standard");
    expect(quotaFamilyFor("trn1.32xlarge")).not.toBe("Standard");
    expect(quotaFamilyFor("inf1.xlarge")).not.toBe("Standard");
  });

  it("shares the G quota with VT", () => {
    expect(quotaFamilyFor("g5.xlarge")).toBe("G");
    expect(quotaFamilyFor("vt1.3xlarge")).toBe("G");
  });

  it("maps single-letter families", () => {
    expect(quotaFamilyFor("p5.48xlarge")).toBe("P");
    expect(quotaFamilyFor("x2iedn.xlarge")).toBe("X");
    expect(quotaFamilyFor("f1.2xlarge")).toBe("F");
  });

  it("falls back to Standard for the general-purpose letters", () => {
    for (const t of ["a1.large", "c7g.large", "m7i.large", "r7i.large", "t3.micro", "i4i.large", "z1d.large"]) {
      expect(quotaFamilyFor(t)).toBe("Standard");
    }
  });
});

describe("vcpusForSize", () => {
  it("maps the named sizes", () => {
    expect(vcpusForSize("t3.nano")).toBe(1);
    expect(vcpusForSize("t3.medium")).toBe(1);
    expect(vcpusForSize("m7i.large")).toBe(2);
    expect(vcpusForSize("m7i.xlarge")).toBe(4);
  });
  it("applies the N*4 rule for Nxlarge", () => {
    expect(vcpusForSize("m7i.2xlarge")).toBe(8);
    expect(vcpusForSize("m7i.24xlarge")).toBe(96);
    expect(vcpusForSize("m7i.48xlarge")).toBe(192);
    expect(vcpusForSize("m7i.20xlarge")).toBe(80); // the general rule, not a table entry
  });
  it("returns undefined for unparseable or unknown sizes", () => {
    // Diverges from Go, which guesses 2 and logs. Here the caller has real vcpus.
    expect(vcpusForSize("weird")).toBeUndefined();
    expect(vcpusForSize("m7i.metal")).toBeUndefined();
    expect(vcpusForSize("m7i.jumbo")).toBeUndefined();
  });
});

describe("quotaIncreaseCommand", () => {
  it("uses the on-demand code by default and the spot code when asked", () => {
    expect(quotaIncreaseCommand("us-east-1", "P", 64)).toContain(QUOTA_CODES.P.onDemand);
    expect(quotaIncreaseCommand("us-east-1", "P", 64, true)).toContain(QUOTA_CODES.P.spot);
    expect(quotaIncreaseCommand("eu-west-1", "G", 8)).toContain("--region eu-west-1");
  });
});

describe("canLaunch", () => {
  const snap = (over: Partial<QuotaInfo> = {}): QuotaInfo => ({
    region: "us-east-1",
    onDemand: { Standard: 64, P: 8 },
    spot: { Standard: 32 },
    usage: { Standard: 16 },
    lastUpdated: "2026-07-31T00:00:00.000Z",
    ...over,
  });

  it("allows a launch that fits the remaining headroom", () => {
    const v = canLaunch(inst("m7i.4xlarge", 16), snap());
    expect(v.canLaunch).toBe(true);
    expect(v.family).toBe("Standard");
    expect(v.availableVcpus).toBe(48); // 64 - 16 used
    expect(v.requestedVcpus).toBe(16);
  });

  it("refuses a launch that exceeds headroom and names the family", () => {
    const v = canLaunch(inst("m7i.24xlarge", 96), snap());
    expect(v.canLaunch).toBe(false);
    expect(v.reason).toMatch(/exceeds/);
    expect(v.reason).toMatch(/Standard/);
  });

  it("checks the SPOT limit when spot=true", () => {
    // 32 spot limit, 16 used → 16 free; a 32-vCPU launch fits on-demand but not spot.
    expect(canLaunch(inst("m7i.8xlarge", 32), snap()).canLaunch).toBe(true);
    expect(canLaunch(inst("m7i.8xlarge", 32), snap(), true).canLaunch).toBe(false);
  });

  it("treats an UNKNOWN limit as launchable, not as zero", () => {
    // The load-bearing asymmetry: a missing quota must not read as "limit 0".
    // A false "cannot launch" blocks a launch that would have succeeded.
    const v = canLaunch(inst("trn1.32xlarge", 128), snap());
    expect(v.canLaunch).toBe(true);
    expect(v.reason).toMatch(/unknown/i);
    expect(v.availableVcpus).toBeUndefined();
  });

  it("says so when the family's lookup explicitly failed", () => {
    const v = canLaunch(inst("trn1.32xlarge", 128), snap({ incomplete: ["Trn"] }));
    expect(v.canLaunch).toBe(true);
    expect(v.reason).toMatch(/lookup failed/);
  });

  it("treats absent usage as zero used", () => {
    const v = canLaunch(inst("p5.48xlarge", 8), snap({ usage: {} }));
    expect(v.canLaunch).toBe(true);
    expect(v.availableVcpus).toBe(8);
  });

  it("does not refuse when the vCPU count is unknown", () => {
    const v = canLaunch({ ...inst("m7i.mystery", 0), vcpus: 0 }, snap());
    expect(v.canLaunch).toBe(true);
    expect(v.reason).toMatch(/unknown/i);
  });

  it("clamps headroom at zero when usage exceeds the limit", () => {
    const v = canLaunch(inst("m7i.large", 2), snap({ usage: { Standard: 999 } }));
    expect(v.availableVcpus).toBe(0);
    expect(v.canLaunch).toBe(false);
  });
});

/** Stub ServiceQuotas.send; `handler(quotaCode)` returns a value or throws. */
function stubQuotas(handler: (quotaCode: string) => number | undefined) {
  const asked: string[] = [];
  vi.spyOn(ServiceQuotasClient.prototype, "send").mockImplementation(function (this: unknown, cmd: any) {
    const code = cmd.input.QuotaCode as string;
    asked.push(code);
    const v = handler(code);
    if (v === undefined) return Promise.reject(new Error(`no quota ${code}`));
    return Promise.resolve({ Quota: { Value: v } });
  } as any);
  return asked;
}

describe("fetchQuotas", () => {
  it("collects on-demand and spot limits per family", async () => {
    stubQuotas((code) => (code === QUOTA_CODES.Standard.onDemand ? 64 : code === QUOTA_CODES.Standard.spot ? 32 : 4));
    const out = await fetchQuotas(new ServiceQuotasClient({ region: "us-east-1" }), "us-east-1");
    expect(out.onDemand.Standard).toBe(64);
    expect(out.spot.Standard).toBe(32);
    expect(out.incomplete).toBeUndefined();
  });

  it("asks for every family, both on-demand and spot", async () => {
    const asked = stubQuotas(() => 1);
    await fetchQuotas(new ServiceQuotasClient({ region: "us-east-1" }), "us-east-1");
    expect(asked).toHaveLength(QUOTA_FAMILIES.length * 2);
    expect(new Set(asked).size).toBe(QUOTA_FAMILIES.length * 2); // no duplicate codes
  });

  it("records a partly-failed family in `incomplete` without failing the whole call", async () => {
    stubQuotas((code) => {
      const p = QUOTA_CODES.P;
      if (code === p.onDemand || code === p.spot) return undefined; // both P lookups fail
      return 16;
    });
    const out = await fetchQuotas(new ServiceQuotasClient({ region: "us-east-1" }), "us-east-1");
    expect(out.incomplete).toEqual(["P"]);
    expect(out.onDemand.P).toBeUndefined();
    expect(out.onDemand.Standard).toBe(16); // the rest survived
  });

  it("throws when EVERY lookup fails, rather than reporting all-zero quotas", async () => {
    // #63 invariant: total failure must not be indistinguishable from "no quota".
    stubQuotas(() => undefined);
    await expect(fetchQuotas(new ServiceQuotasClient({ region: "us-east-1" }), "us-east-1")).rejects.toThrow(
      /all \d+ quota lookups failed/,
    );
  });

  it("ignores a non-numeric quota value", async () => {
    vi.spyOn(ServiceQuotasClient.prototype, "send").mockImplementation(
      () => Promise.resolve({ Quota: { Value: "lots" } }) as any,
    );
    await expect(fetchQuotas(new ServiceQuotasClient({ region: "us-east-1" }), "us-east-1")).rejects.toThrow(/all/);
  });
});

describe("fetchUsage", () => {
  function stubEc2Instances(pages: any[]) {
    let i = 0;
    vi.spyOn(EC2Client.prototype, "send").mockImplementation(() => Promise.resolve(pages[i++]) as any);
  }

  it("sums vCPUs per family from CpuOptions when present", async () => {
    stubEc2Instances([
      {
        Reservations: [
          { Instances: [{ InstanceType: "m7i.4xlarge", CpuOptions: { CoreCount: 8, ThreadsPerCore: 2 } }] },
          { Instances: [{ InstanceType: "p5.48xlarge", CpuOptions: { CoreCount: 96, ThreadsPerCore: 2 } }] },
        ],
      },
    ]);
    const { usage, runningInstances } = await fetchUsage(new EC2Client({ region: "us-east-1" }));
    expect(usage.Standard).toBe(16);
    expect(usage.P).toBe(192);
    expect(runningInstances).toBe(2);
  });

  it("falls back to the size table when CpuOptions is absent", async () => {
    stubEc2Instances([{ Reservations: [{ Instances: [{ InstanceType: "m7i.2xlarge" }] }] }]);
    const { usage } = await fetchUsage(new EC2Client({ region: "us-east-1" }));
    expect(usage.Standard).toBe(8);
  });

  it("follows NextToken so a large account is not understated", async () => {
    // Go reads only the first page; this port paginates.
    stubEc2Instances([
      { Reservations: [{ Instances: [{ InstanceType: "m7i.large" }] }], NextToken: "p2" },
      { Reservations: [{ Instances: [{ InstanceType: "m7i.large" }] }] },
    ]);
    const { usage, runningInstances } = await fetchUsage(new EC2Client({ region: "us-east-1" }));
    expect(usage.Standard).toBe(4); // 2 + 2 across both pages
    expect(runningInstances).toBe(2);
  });

  it("skips instances with no type and unparseable sizes", async () => {
    stubEc2Instances([
      { Reservations: [{ Instances: [{}, { InstanceType: "m7i.mystery" }, { InstanceType: "m7i.large" }] }] },
    ]);
    const { usage, runningInstances } = await fetchUsage(new EC2Client({ region: "us-east-1" }));
    expect(usage.Standard).toBe(2); // only the parseable one contributed
    expect(runningInstances).toBe(2); // both typed instances counted
  });
});
