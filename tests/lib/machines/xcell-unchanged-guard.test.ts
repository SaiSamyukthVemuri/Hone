import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { planContractPublication } from "../../../lib/machines/contract-publication";

// HON-8 re-scope (4 Nov 2026): the Junior/Senior work must not change xCell support in any way. This pins the xCell catalogue entry
// to the exact bytes it has on production (7936f5b2a), so any edit to its fields, modes, evidence or availability fails here.
// If an xCell change is ever wanted on purpose, that is a separate decision and this hash is updated in that change, not in HON-8's.
//
// HON-71 (18 Nov 2026), a DELIBERATE and reviewed change to this guard: a separate `dectro-apilus:xcell-pur` profile now exists (blocked when it landed, ENABLED by the evidence change)
// beside the xCell entry (lib/machines/xcell-pur.ts). The guard therefore expects TWO profiles matching /xcell/i instead of one. The xCell
// entry itself is still pinned to the same hash, byte for byte: it was selected by its exact id, not by position, and not changed.
const XCELL_ENTRY_SHA256 = "96702e7aeae76762f4536e71740de5e1c39403c87e7f44b521f060216f518dce";

describe("xCell catalogue entry is unchanged by HON-8", () => {
  const xcell = MACHINE_CATALOGUE.filter((p) => p.profileId === "dectro-apilus:xcell");

  it("the xCell entry is exactly one profile, version 1, blocked, as before", () => {
    expect(xcell.map((p) => [p.profileId, p.version, p.availability])).toEqual([["dectro-apilus:xcell", 1, "blocked"]]);
  });

  it("there are exactly two profiles matching /xcell/i: the unchanged entry and the separate xCell Pur profile (HON-71, enabled on device-observed evidence)", () => {
    expect(
      MACHINE_CATALOGUE.filter((p) => /xcell/i.test(p.profileId)).map((p) => [p.profileId, p.version, p.availability]),
    ).toEqual([
      ["dectro-apilus:xcell-pur", 1, "active"],
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

// HON-71 enablement: the published Senior/Junior 3G contracts and the rows the plan publishes for every OTHER profile are pinned byte for
// byte, as measured on the production branch before xCell Pur was enabled. Enabling xCell Pur adds its own rows and changes none of these.
const THREE_G_SHA256: Record<string, string> = {
  "dectro-apilus:senior-3g@1": "bd8441a4089f6faeaf09f36af1572d551a9c17620af2bfe4fc7d317e9099744c",
  "dectro-apilus:junior-3g@1": "b63a5b16d3ab4cb726754a953ee1dd015078f4b26e25ca2cf0d484a4b3c433c4",
  "dectro-apilus:senior-3g@2": "1cfd422b6fef40b631ab9de3de2b8c46782c153fe18386938f61222ee13c2c56",
  "dectro-apilus:junior-3g@2": "1a18828be77b2b67ee77f90f322c34d9458746661efd8782b002d412182b3b7a",
  "dectro-apilus:senior-3g@3": "77ff5d160ce52b9c6fc48eadbc1b3e4f3072edb6d2252ac1b51dfde53348beba",
  "dectro-apilus:junior-3g@3": "44e07edde866f905dc3e5e4fe0e0e2a86cc0ddbe0414a10b13a7ca8c34ae8875",
};
const OTHER_PUBLISH_ROWS_SHA256 = "4bd25d2b6c31beac436ad781361999507f658d1c7b4339a1d3d9968556146d45";
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe("enabling xCell Pur leaves the published Senior/Junior contracts and every other publication row byte-identical (HON-71)", () => {
  it("each Senior/Junior 3G profile, at every version, hashes exactly as on production", () => {
    const seen = Object.fromEntries(
      MACHINE_CATALOGUE.filter((p) => /apilus:(senior|junior)-3g/.test(p.profileId)).map((p) => [`${p.profileId}@${p.version}`, sha(p)]),
    );
    expect(seen).toEqual(THREE_G_SHA256);
  });

  it("the plan's rows for every profile other than xCell Pur hash exactly as on production", () => {
    const rows = planContractPublication().publish.filter((r) => r.p_machine_profile_id !== "dectro-apilus:xcell-pur");
    expect(sha(rows)).toBe(OTHER_PUBLISH_ROWS_SHA256);
  });
});
