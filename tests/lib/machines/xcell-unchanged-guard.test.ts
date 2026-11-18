import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";

// HON-8 re-scope (4 Nov 2026): the Junior/Senior work must not change xCell support in any way. This pins the xCell catalogue entry
// to the exact bytes it has on production (7936f5b2a), so any edit to its fields, modes, evidence or availability fails here.
// If an xCell change is ever wanted on purpose, that is a separate decision and this hash is updated in that change, not in HON-8's.
//
// HON-71 (18 Nov 2026), a DELIBERATE and reviewed change to this guard: a separate, blocked `dectro-apilus:xcell-pur` profile now exists
// beside the xCell entry (lib/machines/xcell-pur.ts). The guard therefore expects TWO profiles matching /xcell/i instead of one. The xCell
// entry itself is still pinned to the same hash, byte for byte: it was selected by its exact id, not by position, and not changed.
const XCELL_ENTRY_SHA256 = "96702e7aeae76762f4536e71740de5e1c39403c87e7f44b521f060216f518dce";

describe("xCell catalogue entry is unchanged by HON-8", () => {
  const xcell = MACHINE_CATALOGUE.filter((p) => p.profileId === "dectro-apilus:xcell");

  it("the xCell entry is exactly one profile, version 1, blocked, as before", () => {
    expect(xcell.map((p) => [p.profileId, p.version, p.availability])).toEqual([["dectro-apilus:xcell", 1, "blocked"]]);
  });

  it("there are exactly two profiles matching /xcell/i: the unchanged entry and the separate blocked xCell Pur profile (HON-71)", () => {
    expect(
      MACHINE_CATALOGUE.filter((p) => /xcell/i.test(p.profileId)).map((p) => [p.profileId, p.version, p.availability]),
    ).toEqual([
      ["dectro-apilus:xcell-pur", 1, "blocked"],
      ["dectro-apilus:xcell", 1, "blocked"],
    ]);
  });

  it("its whole definition is byte-identical to production's", () => {
    expect(createHash("sha256").update(JSON.stringify(xcell[0])).digest("hex")).toBe(XCELL_ENTRY_SHA256);
  });

  it("no Junior or Senior 3G profile reuses an xCell field or evidence id", () => {
    const xcellEvidence = new Set(xcell[0]!.evidence.map((e) => e.id));
    for (const p of MACHINE_CATALOGUE.filter((p) => /apilus:(senior|junior)-3g/.test(p.profileId) && p.version === 3)) {
      for (const e of p.evidence) expect(xcellEvidence.has(e.id), `${p.profileId} cites xCell evidence ${e.id}`).toBe(false);
    }
  });

  it("the xCell Pur profile reuses no evidence id of the xCell entry or of any 3G profile, and is not the xCell entry's id", () => {
    const pur = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell-pur")!;
    const others = new Set(
      MACHINE_CATALOGUE.filter((p) => p.profileId !== pur.profileId).flatMap((p) => p.evidence.map((e) => e.id)),
    );
    for (const e of pur.evidence) expect(others.has(e.id), `xcell-pur cites ${e.id}, which another profile also cites`).toBe(false);
  });
});
