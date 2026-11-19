import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { blockHoldsReadings, purLegacyModeRefused } from "@/lib/machines/identity-choice";

type Answers = { block?: unknown[]; native?: unknown[]; entries?: unknown[]; fail?: string };
const fake = (a: Answers) =>
  ({
    from: (t: string) => {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "limit"]) chain[k] = () => chain;
      chain.then = (res: (v: unknown) => unknown) =>
        res(a.fail === t ? { data: null, error: { message: "x" } } : { data: t === "session_blocks" ? (a.block ?? [{ id: "b" }]) : t === "treatment_setup_readings" ? (a.native ?? []) : (a.entries ?? []), error: null });
      return chain;
    },
  }) as never;

describe("blockHoldsReadings (the server's machine freeze input)", () => {
  it("no readings anywhere: free to change", async () => {
    expect(await blockHoldsReadings(fake({ entries: [{ galvanic_ma: null, energy_level: null }] }), "b", "s")).toBe(false);
  });
  it("a legacy reading holds it", async () => {
    expect(await blockHoldsReadings(fake({ entries: [{ galvanic_ma: 2 }] }), "b", "s")).toBe(true);
  });
  it("a REMOVED entry's reading does not hold it", async () => {
    expect(await blockHoldsReadings(fake({ entries: [{ deleted_at: "2026-11-19T10:00:00Z", galvanic_ma: 2 }] }), "b", "s")).toBe(false);
  });
  it("a native setup reading holds it", async () => {
    expect(await blockHoldsReadings(fake({ native: [{ id: "r" }] }), "b", "s")).toBe(true);
  });
  it("an unknown block or a failed read HOLDS (never a guess that lets a change through)", async () => {
    expect(await blockHoldsReadings(fake({ block: [] }), "b", "s")).toBe(true);
    for (const fail of ["session_blocks", "treatment_setup_readings", "electrolysis_entries"]) expect(await blockHoldsReadings(fake({ fail }), "b", "s")).toBe(true);
  });
});

describe("purLegacyModeRefused", () => {
  const pur = "dectro-apilus:xcell-pur";
  it("on: Pur with a legacy mode is refused; with no mode, another model or the legacy xCell it is not", () => {
    for (const mode of ["thermo", "blend", "galv"]) expect(purLegacyModeRefused({ redesignOn: true, mode, profileId: pur })).toBe(true);
    expect(purLegacyModeRefused({ redesignOn: true, mode: null, profileId: pur })).toBe(false);
    expect(purLegacyModeRefused({ redesignOn: true, mode: "thermo", profileId: "dectro-apilus:xcell" })).toBe(false);
  });
  it("off: never refused here (today's behaviour)", () => {
    expect(purLegacyModeRefused({ redesignOn: false, mode: "thermo", profileId: pur })).toBe(false);
  });
});

describe("the identity action is frozen behind the rollout (source pin)", () => {
  it("checks the rollout, spares an identical retry, and refuses a change once readings exist", () => {
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts", "utf8");
    expect(src).toMatch(/if \(await chartingRolloutFor\(scope\.studioId\)\) \{\s*const same = await storedIdentityMatches/);
    expect(src).toMatch(/if \(!same && \(await blockHoldsReadings\(db, input\.blockId, input\.sessionId\)\)\) \{\s*return \{ ok: false, code: "rejected", error: IDENTITY_FROZEN_MESSAGE \}/);
  });
});
