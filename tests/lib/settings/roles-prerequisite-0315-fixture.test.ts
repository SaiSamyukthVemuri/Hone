import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG, catalogByKey, checkChange } from "@/lib/permissions/catalog";
import { buildRoleModel, applyEdit } from "@/lib/settings/roles/model";
import { parseError } from "@/lib/settings/roles/core-parse";
import type { PolicyWithServer } from "@/lib/settings/roles/server-effective";

// Migration 0315 (built locally, NOT applied) makes clin.upload_photos also require clin.edit_records. The Roles page is built against the
// 0287 seed, where upload_photos requires only clin.view_photos. This fixture adds the 0315 prerequisite to the catalog entry for the
// duration of this file (restored in afterAll) and checks that the page already shows it: the row says what it needs, the option that
// would need it is refused with a reason, and the core's prerequisite_unmet answer is turned into the owner-facing line.
const UPLOAD = "clin.upload_photos";
const NEEDED = "clin.edit_records";
const entry = catalogByKey.get(UPLOAD)!;
const original = [...entry.requires];

beforeAll(() => {
  expect(CATALOG.some((d) => d.key === UPLOAD)).toBe(true);
  expect(original, "the 0287 seed shape this fixture extends").not.toContain(NEEDED);
  (entry.requires as string[]).push(NEEDED);
});
afterAll(() => {
  (entry.requires as string[]).splice(0, entry.requires.length, ...original);
});

const policy = (values: Record<string, "off" | "own" | "studio">): PolicyWithServer => ({ basis: "new_studio", values, gates: {} });
const rowOf = (p: PolicyWithServer) => buildRoleModel("practitioner", p).flatMap((g) => g.rows).find((r) => r.key === UPLOAD)!;

describe("0315 prerequisite (clin.upload_photos needs clin.edit_records), by fixture", () => {
  it("the row names the new prerequisite", () => {
    const label = catalogByKey.get(NEEDED)!.label;
    expect(rowOf(policy({})).needs).toContain(label);
  });
  it("with edit records off, a saved upload choice is shown inactive and says what it needs", () => {
    const p = policy({ [UPLOAD]: "studio", [NEEDED]: "off", "clin.view_photos": "studio", "clin.view_records": "studio" });
    const r = rowOf(p);
    expect(r.chosen).toBe("studio");
    expect(r.effective).toBe("off");
    expect(r.inactiveBecause).toContain(catalogByKey.get(NEEDED)!.label);
  });
  it("turning upload on while edit records is off is refused with a reason, and nothing is applied", () => {
    const p = policy({ [UPLOAD]: "off", [NEEDED]: "off", "clin.view_photos": "studio", "clin.view_records": "studio" });
    const check = checkChange("practitioner", UPLOAD, "studio", p);
    expect(check.ok).toBe(false);
    const edited = applyEdit("practitioner", p, UPLOAD, "studio");
    expect(edited.ok).toBe(false);
  });
  it("with edit records on, the same change is allowed (control)", () => {
    const p = policy({ [UPLOAD]: "off", [NEEDED]: "studio", "clin.view_photos": "studio", "clin.view_records": "studio" });
    expect(checkChange("practitioner", UPLOAD, "studio", p).ok).toBe(true);
  });
  it("the core's prerequisite_unmet answer for it parses to the error the page shows, with the key and role", () => {
    const e = parseError({ ok: false, code: "prerequisite_unmet", key: UPLOAD, role: "practitioner", blocked_by: NEEDED });
    expect(e).toEqual({ code: "prerequisite_unmet", key: UPLOAD, role: "practitioner" });
  });
});
