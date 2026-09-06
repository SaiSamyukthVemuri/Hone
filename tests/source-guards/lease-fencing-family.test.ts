import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BILLABLE_OR_MUTATING_EFFECTS,
  CLAIM_SCOPED_READS,
  FENCED_PROVIDER_OPERATIONS,
  PRE_CLAIM_READS,
} from "@/lib/sms/provider/fenced";

// COMMS-01B — THE LEASE-FENCING FAMILY GUARD.
//
// Three consecutive reviews found the same defect wearing three faces:
//   1. the purchase was fenced; the ADOPTED path was not;
//   2. provider mutations were fenced; the finalize-error WRITE was not;
//   3. a write's `lease_lost` answer was discarded and a stale provider error
//      reported over it.
//
// Each was fixed where it was found, and that was the mistake: fencing was a
// RULE THE CALLER HAD TO REMEMBER, applied by hand at each await. A rule you
// have to remember is one that is eventually forgotten.
//
// An earlier revision of this file guarded that rule by measuring the LINE
// DISTANCE between a fence and the call it protected. That guard is gone, and
// so is what it guarded: the fence is now a TYPE (lib/sms/provider/fenced.ts).
// The orchestration receives a provider that cannot perform an unfenced
// effect, so there is no longer a call site at which to forget, and no
// heuristic needed to check one.
//
// What remains genuinely un-structural, and is therefore guarded here:
//
//   A. the CLASSIFICATION must stay exhaustive -- a new port method that is
//      neither mutating nor read-only would slip through the wrapper;
//   B. the orchestration must not reach PAST the wrapper to the raw provider;
//   C. no authoritative write may DISCARD its result, because the database's
//      `lease_lost` outranks whatever this worker was about to say. TypeScript
//      cannot express "you must inspect this return value".

const ROOT = path.resolve(__dirname, "../..");
const ORCHESTRATION = "lib/sms/provisioning.ts";
const PORT = "lib/sms/provider/types.ts";

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Source with comment lines removed: a negative assertion must not be met by prose. */
function code(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const SRC = code(ORCHESTRATION);
const LINES = SRC.split("\n");

/**
 * Just the provisioning function's body.
 *
 * Scoped deliberately: `searchAvailableSenderNumbers` is a SEPARATE, read-only
 * entry point that takes its own provider and holds no claim at all, so it has
 * nothing to fence. Counting it would make this guard fire on correct code,
 * and a guard that cries wolf gets deleted.
 */
const PROVISION_BODY = SRC.slice(SRC.indexOf("export async function provisionStudioSmsSender"));

// ---------------------------------------------------------------------------
// A. The classification is exhaustive
// ---------------------------------------------------------------------------

describe("A — every provider port method is classified", () => {
  it("the three groups are disjoint", () => {
    const groups = [BILLABLE_OR_MUTATING_EFFECTS, CLAIM_SCOPED_READS, PRE_CLAIM_READS];
    const all = groups.flatMap((g) => [...g]);
    expect(new Set(all).size, "a method appears in more than one group").toBe(all.length);
  });

  it("everything a provisioning attempt can do is fenced", () => {
    // The union the wrapper actually guards. `searchAvailableNumbers` is the
    // ONLY unfenced member of the port, and it is pre-claim: unreachable from
    // an attempt, because no generation exists yet to check.
    expect([...FENCED_PROVIDER_OPERATIONS].sort()).toEqual(
      [...BILLABLE_OR_MUTATING_EFFECTS, ...CLAIM_SCOPED_READS].sort(),
    );
    expect(PRE_CLAIM_READS).toEqual(["searchAvailableNumbers"]);
  });

  it("every method the PORT declares appears in exactly one list", () => {
    // Read the interface itself rather than a copy of it: a method added to
    // SmsProvisioningProvider and classified nowhere is precisely how the
    // adopted path shipped unfenced.
    const iface = read(PORT);
    const block = iface.slice(
      iface.indexOf("export interface SmsProvisioningProvider"),
      iface.indexOf("\n}", iface.indexOf("export interface SmsProvisioningProvider")),
    );
    expect(block).toBeTruthy();

    const declared = new Set(
      [...block.matchAll(/^\s{2}([a-zA-Z]+)\s*\(/gm)].map((m) => m[1]),
    );
    // `name` is a readonly property, not an operation.
    declared.delete("name");
    expect(declared.size).toBeGreaterThanOrEqual(9);

    const classified = new Set<string>([
      ...BILLABLE_OR_MUTATING_EFFECTS,
      ...CLAIM_SCOPED_READS,
      ...PRE_CLAIM_READS,
    ]);
    const unclassified = [...declared].filter((m) => !classified.has(m));
    expect(
      unclassified,
      "A provider port method is classified neither mutating nor read-only, so " +
        "fenceProviderMutations would pass it through unfenced.",
    ).toEqual([]);

    const phantom = [...classified].filter((m) => !declared.has(m));
    expect(phantom, "A classified method no longer exists on the port.").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. The orchestration cannot reach past the fence
// ---------------------------------------------------------------------------

describe("B — the raw provider is unreachable after the fence is built", () => {
  it("builds the fenced provider exactly once", () => {
    expect(PROVISION_BODY).toMatch(/const provider = fenceProviderMutations\(\s*input\.provider,/);
    expect((PROVISION_BODY.match(/fenceProviderMutations\(/g) ?? [])).toHaveLength(1);
  });

  it("never calls a fenced operation on the unfenced provider", () => {
    for (const effect of FENCED_PROVIDER_OPERATIONS) {
      const bypass = new RegExp(`input\\.provider\\.${effect}\\(`);
      expect(
        bypass.test(PROVISION_BODY),
        `${effect} is invoked on input.provider, bypassing the fence. Call it ` +
          "on the wrapped `provider` instead.",
      ).toBe(false);
    }
  });

  it("does not read input.provider at all beyond constructing the wrapper", () => {
    const uses = (PROVISION_BODY.match(/input\.provider/g) ?? []).length;
    expect(uses, "input.provider is referenced outside fenceProviderMutations(...)").toBe(1);
  });
});

// ---------------------------------------------------------------------------
// C. No authoritative write discards its result
// ---------------------------------------------------------------------------

describe("C — the database's verdict is always read", () => {
  const AUTHORITATIVE_WRITES = ["finalize", "fail"] as const;

  it.each(AUTHORITATIVE_WRITES)(
    "every input.store.%s() result is bound, never discarded",
    (write) => {
      const sites = LINES.map((text, i) => ({ line: i + 1, text })).filter((l) =>
        new RegExp(`input\\.store\\.${write}\\(`).test(l.text),
      );
      expect(sites.length, `no input.store.${write}() call found`).toBeGreaterThan(0);
      for (const site of sites) {
        // A bare `await input.store.X({` at statement position throws the
        // answer away, which is defect #3 of the family.
        const discarded = /^\s*await\s+input\.store\.[a-zA-Z]+\(/.test(site.text);
        expect(
          discarded,
          `input.store.${write}() at line ${site.line} discards its result. Bind ` +
            "it and inspect for lease_lost: a displaced worker must not overwrite " +
            "a newer worker's truth with its own stale error.",
        ).toBe(false);
      }
    },
  );

  it("failWith's result is never discarded either", () => {
    const sites = LINES.map((text, i) => ({ line: i + 1, text })).filter(
      (l) => /(^|\s)await failWith\(/.test(l.text),
    );
    for (const site of sites) {
      const discarded = /^\s*await\s+failWith\(/.test(site.text);
      expect(
        discarded,
        `failWith() at line ${site.line} discards its result. It already converts ` +
          "a refused write into lease_lost; throwing that away reports the stale " +
          "worker's error to the owner.",
      ).toBe(false);
    }
  });

  it("displacement has exactly ONE constructor, so it cannot drift", () => {
    expect(SRC).toMatch(/const displaced = \(\): ProvisionOutcome => \(\{/);
    // Object literals only: `result: "lease_lost",` constructs an outcome,
    // whereas `result: "lease_lost";` is the type declaring the arm exists.
    const constructed = (SRC.match(/result: "lease_lost",/g) ?? []).length;
    expect(constructed, "lease_lost outcome is built in more than one place").toBe(1);
  });

  it("a lease_lost verdict is still inspected in several places", () => {
    // Not a count that must match one-to-one, but a codebase that stopped
    // mentioning lease_lost after a write has stopped checking.
    const checks = (SRC.match(/=== "lease_lost"|wrote\(/g) ?? []).length;
    expect(checks).toBeGreaterThanOrEqual(4);
  });
});
