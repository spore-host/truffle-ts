// EC2 vCPU service-quota surfacing — the TS port of Go pkg/quotas. AWS meters
// On-Demand and Spot vCPUs PER FAMILY, so "can I launch this?" needs the family
// and the instance's vCPU count, not just its name.
//
// Everything in this file except fetchQuotas/fetchUsage is PURE, so the mapping
// and arithmetic are unit-testable without the SDK (the same split pricing.ts
// uses for parseOnDemandUsd).

import {
  ServiceQuotasClient,
  GetServiceQuotaCommand,
} from "@aws-sdk/client-service-quotas";
import { EC2Client, DescribeInstancesCommand } from "@aws-sdk/client-ec2";

import type { QuotaFamily, QuotaInfo, QuotaVerdict } from "../core/finder.js";
import type { InstanceType } from "../core/types.js";

/**
 * Service-quota codes, per family, for On-Demand and Spot vCPUs. These are AWS
 * global constants (same code in every region) — ported verbatim from Go
 * pkg/quotas so the two tools ask about the same limits.
 */
export const QUOTA_CODES: Record<QuotaFamily, { onDemand: string; spot: string }> = {
  Standard: { onDemand: "L-1216C47A", spot: "L-34B43A08" },
  F: { onDemand: "L-74FC7D96", spot: "L-88CF9481" },
  // G and VT share one quota, both On-Demand and Spot.
  G: { onDemand: "L-DB2E81BA", spot: "L-3819A6DF" },
  P: { onDemand: "L-417A185B", spot: "L-7212CCBC" },
  X: { onDemand: "L-7295265B", spot: "L-E3A00192" },
  Inf: { onDemand: "L-1945791B", spot: "L-B5D1601B" },
  Trn: { onDemand: "L-2C3B7624", spot: "L-5480EFD2" },
  DL: { onDemand: "L-6E869C2A", spot: "L-85EED4F7" },
};

/** Every family, in a stable order (drives the fetch fan-out and tests). */
export const QUOTA_FAMILIES = Object.keys(QUOTA_CODES) as QuotaFamily[];

/**
 * The leading run of lowercase letters, e.g. "dl2q.24xlarge" → "dl".
 *
 * Deliberately a letter-RUN scan rather than a prefix match: Go #64 was a real
 * bug where startsWith-style matching misfiled multi-letter families ("dl", "vt",
 * "trn", "inf") under a single-letter case, because "dl1..." also starts with
 * "d". Don't "simplify" this back to startsWith.
 */
export function letterPrefix(instanceType: string): string {
  const m = /^[a-z]*/.exec(instanceType);
  return m ? m[0] : "";
}

/** The vCPU quota family metering `instanceType`. Ports Go GetQuotaFamily. */
export function quotaFamilyFor(instanceType: string): QuotaFamily {
  switch (letterPrefix(instanceType)) {
    case "p":
      return "P";
    case "g":
    case "vt": // VT (video transcoding) shares the "G and VT" quota.
      return "G";
    case "inf":
      return "Inf";
    case "trn":
      return "Trn";
    case "dl":
      return "DL";
    case "f":
      return "F";
    case "x":
      return "X";
    default:
      return "Standard"; // a, c, d, h, i, m, r, t, z, …
  }
}

/** Exact vCPU counts for the named sizes (the non-`Nxlarge` ones). */
const SIZE_VCPUS: Record<string, number> = {
  nano: 1,
  micro: 1,
  small: 1,
  medium: 1,
  large: 2,
  xlarge: 4,
  metal: 0, // resolved by the caller from real specs; 0 = unknown here
};

/**
 * vCPUs for an instance type's size suffix. Ports Go getVCPUCount, including its
 * `Nxlarge → N*4` general rule.
 *
 * Returns `undefined` rather than Go's silent `2` fallback when the size can't be
 * parsed. Go logs a warning and understates usage; here the caller has the real
 * `InstanceType.vcpus` available and should prefer it, so guessing would be
 * strictly worse. Only used for foreign types (a running instance the catalog
 * doesn't describe).
 */
export function vcpusForSize(instanceType: string): number | undefined {
  const size = instanceType.split(".")[1];
  if (!size) return undefined;
  const exact = SIZE_VCPUS[size];
  if (exact !== undefined) return exact === 0 ? undefined : exact;
  const m = /^(\d+)xlarge$/.exec(size);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n * 4;
  }
  return undefined;
}

/**
 * Whether `instance` fits in the remaining quota for its family. PURE — takes a
 * snapshot, makes no calls, so many types can be checked against one fetch.
 *
 * An unknown limit yields canLaunch: true with a reason saying so. That is
 * deliberate: a missing quota (permissions, a family AWS has not published) must
 * not read as "limit 0 → cannot launch". A false "you cannot launch this" is the
 * worse error, because it stops a launch that would have succeeded.
 */
export function canLaunch(
  instance: InstanceType,
  quotas: QuotaInfo,
  spot = false,
): QuotaVerdict {
  const family = quotaFamilyFor(instance.instanceType);
  const requestedVcpus = instance.vcpus || vcpusForSize(instance.instanceType) || 0;
  const limit = (spot ? quotas.spot : quotas.onDemand)[family];
  const used = quotas.usage[family] ?? 0;
  const kind = spot ? "Spot" : "On-Demand";

  if (limit === undefined) {
    const why = quotas.incomplete?.includes(family)
      ? `${kind} ${family} quota lookup failed — treating as unknown, not exhausted`
      : `${kind} ${family} quota unknown`;
    return { canLaunch: true, reason: why, family, requestedVcpus };
  }

  const availableVcpus = Math.max(0, limit - used);
  if (requestedVcpus === 0) {
    return {
      canLaunch: true,
      reason: `vCPU count unknown for ${instance.instanceType}; ${availableVcpus} of ${limit} ${kind} ${family} vCPUs free`,
      family,
      requestedVcpus,
      availableVcpus,
    };
  }
  if (requestedVcpus <= availableVcpus) {
    return {
      canLaunch: true,
      reason: `${requestedVcpus} vCPU fits in ${availableVcpus} free of ${limit} ${kind} ${family} vCPUs`,
      family,
      requestedVcpus,
      availableVcpus,
    };
  }
  return {
    canLaunch: false,
    reason: `${requestedVcpus} vCPU exceeds ${availableVcpus} free of ${limit} ${kind} ${family} vCPUs (request a ${family} quota increase)`,
    family,
    requestedVcpus,
    availableVcpus,
  };
}

/** The AWS console/CLI command that requests an increase for a family. */
export function quotaIncreaseCommand(
  region: string,
  family: QuotaFamily,
  desiredValue: number,
  spot = false,
): string {
  const code = spot ? QUOTA_CODES[family].spot : QUOTA_CODES[family].onDemand;
  return [
    "aws service-quotas request-service-quota-increase",
    `--region ${region}`,
    "--service-code ec2",
    `--quota-code ${code}`,
    `--desired-value ${desiredValue}`,
  ].join(" ");
}

/**
 * Fetch the On-Demand + Spot vCPU limit for every family in `region`.
 *
 * Per-family failures are collected into `incomplete` instead of rejecting: one
 * unavailable family should not blank out the other seven. If EVERY lookup fails
 * this throws, so a total failure (bad creds, no servicequotas permission) can't
 * masquerade as "all quotas are zero" — the same #63 invariant the spot and
 * search paths hold.
 */
export async function fetchQuotas(
  client: ServiceQuotasClient,
  region: string,
): Promise<Pick<QuotaInfo, "onDemand" | "spot" | "incomplete">> {
  const onDemand: Partial<Record<QuotaFamily, number>> = {};
  const spot: Partial<Record<QuotaFamily, number>> = {};
  const incomplete: QuotaFamily[] = [];

  await Promise.all(
    QUOTA_FAMILIES.map(async (family) => {
      const codes = QUOTA_CODES[family];
      const [od, sp] = await Promise.all([
        getQuotaValue(client, codes.onDemand),
        getQuotaValue(client, codes.spot),
      ]);
      if (od !== undefined) onDemand[family] = od;
      if (sp !== undefined) spot[family] = sp;
      if (od === undefined && sp === undefined) incomplete.push(family);
    }),
  );

  if (incomplete.length === QUOTA_FAMILIES.length) {
    throw new Error(
      `all ${QUOTA_FAMILIES.length} quota lookups failed in ${region} ` +
        `(check servicequotas:GetServiceQuota permission)`,
    );
  }
  return incomplete.length > 0 ? { onDemand, spot, incomplete } : { onDemand, spot };
}

/** One quota value, or undefined if the lookup failed / returned no value. */
async function getQuotaValue(
  client: ServiceQuotasClient,
  quotaCode: string,
): Promise<number | undefined> {
  try {
    const res = await client.send(
      new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: quotaCode }),
    );
    const v = res.Quota?.Value;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Current vCPU usage per family, from running+pending instances. Ports Go
 * getCurrentUsage. Paginates, unlike the Go version, which reads only the first
 * page — an account with enough instances would silently understate usage there.
 */
export async function fetchUsage(
  client: EC2Client,
): Promise<{ usage: Partial<Record<QuotaFamily, number>>; runningInstances: number }> {
  const usage: Partial<Record<QuotaFamily, number>> = {};
  let runningInstances = 0;
  let token: string | undefined;
  do {
    const res = await client.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: "instance-state-name", Values: ["running", "pending"] }],
        NextToken: token,
      }),
    );
    for (const r of res.Reservations ?? []) {
      for (const inst of r.Instances ?? []) {
        const type = inst.InstanceType;
        if (!type) continue;
        runningInstances++;
        const family = quotaFamilyFor(type);
        // Prefer the authoritative count the API reports; fall back to the size
        // table for a type it didn't populate.
        const vcpus = inst.CpuOptions?.CoreCount && inst.CpuOptions?.ThreadsPerCore
          ? inst.CpuOptions.CoreCount * inst.CpuOptions.ThreadsPerCore
          : vcpusForSize(type);
        if (vcpus === undefined) continue;
        usage[family] = (usage[family] ?? 0) + vcpus;
      }
    }
    token = res.NextToken;
  } while (token);
  return { usage, runningInstances };
}
