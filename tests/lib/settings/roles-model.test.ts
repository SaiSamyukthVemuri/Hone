import { describe, expect, it } from "vitest";
import { CATALOG, effectiveScope, FIXED_OWNER_ONLY, ROLES, type PermissionDef, type StudioPolicy } from "@/lib/permissions/catalog";
import { applyEdit, buildRoleModel, groupLabel } from "@/lib/settings/roles/model";
import { defaultsPolicy, diffPolicies, releaseNarrowings } from "@/lib/settings/roles/diff";
import { validateRoleSubmission } from "@/lib/settings/roles/validate";

const defs = CATALOG as readonly PermissionDef[];
const snapshot: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };

describe("Roles page model reads the one catalog", () => {
  it("every offered catalog key appears exactly once per role, in a group", () => {
    for (const role of ROLES) {
      const keys = buildRoleModel(role, snapshot).flatMap((g) => g.rows.map((r) => r.key));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.sort()).toEqual(defs.map((d) => d.key).sort());
    }
  });

  it("a studio's current access is what the page shows: chosen and effective match the existing snapshot", () => {
    for (const role of ROLES) {
      for (const row of buildRoleModel(role, snapshot).flatMap((g) => g.rows)) {
        const d = defs.find((x) => x.key === row.key)!;
        expect(row.chosen, row.key).toBe(d.existingSnapshot[role]);
        expect(row.effective, row.key).toBe(effectiveScope(role, row.key, snapshot));
      }
    }
  });

  it("an unknown policy basis shows everything Off (fail closed), never a default", () => {
    const unknown: StudioPolicy = { basis: null, values: {}, gates: {} };
    for (const row of buildRoleModel("practitioner", unknown).flatMap((g) => g.rows)) expect(row.effective, row.key).toBe("off");
  });

  it("receptionists are never offered 'Own assigned'", () => {
    for (const row of buildRoleModel("receptionist", snapshot).flatMap((g) => g.rows)) {
      expect(row.options.map((o) => o.scope), row.key).not.toContain("own");
    }
  });

  it("a fixed baseline has no live control and says why", () => {
    const cal = buildRoleModel("practitioner", snapshot).flatMap((g) => g.rows).find((r) => r.key === "appt.view_calendar")!;
    expect(cal.locked).toBeTruthy();
    expect(cal.options.every((o) => o.disabled)).toBe(true);
  });

  it("a key whose prerequisite is not on cannot be raised, and the reason names the prerequisite (nothing is enabled silently)", () => {
    // appt.reassign requires appt.move: with move Off, reassign cannot go above Off.
    const base: StudioPolicy = { ...snapshot, values: { "appt.move": "off" } };
    const row = buildRoleModel("practitioner", base).flatMap((g) => g.rows).find((r) => r.key === "appt.reassign")!;
    const raise = row.options.find((o) => o.scope === "studio")!;
    expect(raise.disabled).toBe(true);
    expect(raise.reason).toMatch(/Move appointments/);
    const edit = applyEdit("practitioner", base, "appt.reassign", "studio");
    expect(edit.ok).toBe(false);
    expect(base.values).toEqual({ "appt.move": "off" }); // the draft is unchanged
  });

  it("an allowed edit changes exactly that key and no other", () => {
    const edit = applyEdit("practitioner", snapshot, "appt.reassign", "own");
    if (!edit.ok) throw new Error(edit.reason);
    expect(Object.keys(edit.policy.values)).toEqual(["appt.reassign"]);
  });

  it("turning a prerequisite Off keeps dependents' stored values but they stop being in force, and the page says so", () => {
    const withReassign = applyEdit("practitioner", snapshot, "appt.reassign", "own");
    if (!withReassign.ok) throw new Error(withReassign.reason);
    const lowered = applyEdit("practitioner", withReassign.policy, "appt.move", "off");
    if (!lowered.ok) throw new Error(lowered.reason);
    const row = buildRoleModel("practitioner", lowered.policy).flatMap((g) => g.rows).find((r) => r.key === "appt.reassign")!;
    expect(row.chosen).toBe("own");
    expect(row.effective).toBe("off");
    expect(row.inactiveBecause).toMatch(/Move appointments/);
  });

  it("studio-wide price and fee keys are labelled as affecting future studio business", () => {
    const flagged = defs.filter((d) => d.affectsFutureStudioBusiness).map((d) => d.key);
    expect(flagged.length).toBeGreaterThan(0);
    const rows = buildRoleModel("practitioner", snapshot).flatMap((g) => g.rows);
    for (const k of flagged) expect(rows.find((r) => r.key === k)!.futureBusiness, k).toBe(true);
  });
});

describe("group labels", () => {
  it("a group the map does not know yet still reads as words", () => {
    expect(groupLabel("client_detail_groups")).toBe("Client detail groups");
    expect(groupLabel("clients_identity")).toBe("Clients and identity");
  });
});

describe("'Not available yet' is only for the receptionist legal-name keys (Sam, group 6)", () => {
  const rowsFor = (role: "practitioner" | "receptionist") => buildRoleModel(role, snapshot).flatMap((g) => g.rows);
  it("a receptionist legal-name key carries the note and cannot be raised", () => {
    const withGate = defs.filter((d) => d.shipGate?.receptionist === "receptionist_legal_name");
    expect(withGate.length).toBeGreaterThan(0);
    for (const d of withGate) {
      const row = rowsFor("receptionist").find((r) => r.key === d.key)!;
      expect(row.gateNote, d.key).toBeTruthy();
      expect(row.options.filter((o) => !o.selected).every((o) => o.disabled), d.key).toBe(true);
    }
  });
  it("no practitioner row ever says 'Not available yet', including the legal-name edit they have today", () => {
    for (const r of rowsFor("practitioner")) expect(r.gateNote, r.key).toBeNull();
    const edit = rowsFor("practitioner").find((r) => defs.find((d) => d.key === r.key)?.shipGate?.practitioner === "practitioner_legal_name_edit");
    expect(edit?.heldUntil).toBeTruthy();
    expect(edit?.chosen).not.toBe("off");
  });
  it("other gated keys are plain 'held until' information", () => {
    for (const d of defs.filter((x) => x.shipGate?.receptionist && x.shipGate.receptionist !== "receptionist_legal_name")) {
      const row = rowsFor("receptionist").find((r) => r.key === d.key)!;
      expect(row.gateNote, d.key).toBeNull();
      expect(row.heldUntil, d.key).toBeTruthy();
    }
  });
  it("once the operator marks the gate satisfied the note goes away", () => {
    const d = defs.find((x) => x.shipGate?.receptionist === "receptionist_legal_name")!;
    const row = buildRoleModel("receptionist", { ...snapshot, gates: { receptionist_legal_name: true } }).flatMap((g) => g.rows).find((r) => r.key === d.key)!;
    expect(row.gateNote).toBeNull();
  });
  it("a pending-decision marker shows (pendingDecision is a list, not a boolean)", () => {
    const pend = defs.filter((d) => (d.pendingDecision?.length ?? 0) > 0);
    for (const role of ROLES) {
      const rows = buildRoleModel(role, snapshot).flatMap((g) => g.rows);
      for (const d of pend) expect(rows.find((r) => r.key === d.key)!.pendingDecision, d.key).toBe(true);
    }
  });
});

describe("truthfulness (Insurance P-1)", () => {
  it("every approved_policy row says so, so the page never claims it is today's database behaviour", () => {
    const rows = ROLES.flatMap((role) => buildRoleModel(role, snapshot).flatMap((g) => g.rows));
    const approved = rows.filter((r) => r.snapshotBasis === "approved_policy");
    expect(approved.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.snapshotBasis, r.key).toBe(defs.find((d) => d.key === r.key)!.snapshotBasis);
  });
});

describe("the release-time owner-only change is a standing notice (DN-25)", () => {
  it("lists every fixed owner-only item that narrows access, the same list the adoption preview uses", () => {
    const ids = releaseNarrowings().map((f) => f.id).sort();
    expect(ids).toEqual(FIXED_OWNER_ONLY.filter((f) => f.existingEffect === "narrows").map((f) => f.id).sort());
    expect(diffPolicies("practitioner", snapshot, defaultsPolicy(snapshot)).fixedNarrowings.map((f) => f.id).sort()).toEqual(ids);
  });
});

describe("Reset and adopt preview", () => {
  it("an existing studio's adoption preview names every fixed owner-only item that takes access away (Codex P2)", () => {
    const d = diffPolicies("practitioner", snapshot, defaultsPolicy(snapshot));
    const ids = d.fixedNarrowings.map((f) => f.id).sort();
    expect(ids).toEqual(FIXED_OWNER_ONLY.filter((f) => f.existingEffect === "narrows").map((f) => f.id).sort());
    expect(ids.length).toBeGreaterThan(0);
  });
  it("no fixed narrowing is shown to receptionists or once the studio is already on the new defaults", () => {
    expect(diffPolicies("receptionist", snapshot, defaultsPolicy(snapshot)).fixedNarrowings).toEqual([]);
    expect(diffPolicies("practitioner", defaultsPolicy(snapshot), defaultsPolicy(snapshot)).fixedNarrowings).toEqual([]);
  });

  it("the preview is exactly the effective difference to the new-studio defaults, and applying nothing leaves an already-default policy unchanged", () => {
    for (const role of ROLES) {
      const d = diffPolicies(role, snapshot, defaultsPolicy(snapshot));
      for (const c of d.changes) {
        expect(c.from).toBe(effectiveScope(role, c.key, snapshot));
        expect(c.to).toBe(effectiveScope(role, c.key, defaultsPolicy(snapshot)));
      }
      const again = diffPolicies(role, defaultsPolicy(snapshot), defaultsPolicy(snapshot));
      expect(again.changes).toEqual([]);
    }
  });

  it("a sensitive key going up is flagged as newly enabled; narrowing never is", () => {
    for (const role of ROLES) {
      const d = diffPolicies(role, snapshot, defaultsPolicy(snapshot));
      for (const c of d.changes) {
        const def = defs.find((x) => x.key === c.key)!;
        expect(c.newlyEnabledSensitive, c.key).toBe(c.direction === "widens" && def.sensitive === true);
      }
      expect(d.newlyEnabledSensitive).toBe(d.changes.filter((c) => c.newlyEnabledSensitive).length);
    }
  });
});

describe("a role submission is validated against the catalog, atomically", () => {
  it("refuses an unknown role, key and scope", () => {
    expect(validateRoleSubmission("owner", {}, snapshot).ok).toBe(false);
    expect(validateRoleSubmission("practitioner", { "no.such_key": "studio" }, snapshot).ok).toBe(false);
    expect(validateRoleSubmission("practitioner", { "appt.book": "everyone" }, snapshot).ok).toBe(false);
    expect(validateRoleSubmission("practitioner", [], snapshot).ok).toBe(false);
  });

  it("refuses a dependent above its prerequisite, and one bad key refuses the whole submission", () => {
    const r = validateRoleSubmission("practitioner", { "appt.move": "off", "appt.reassign": "studio", "appt.book": "own" }, snapshot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("appt.reassign");
  });

  it("accepts a prerequisite and its dependent together when consistent", () => {
    expect(validateRoleSubmission("practitioner", { "appt.move": "studio", "appt.reassign": "own" }, snapshot).ok).toBe(true);
  });

  it("refuses a scope the role cannot hold", () => {
    expect(validateRoleSubmission("receptionist", { "appt.book": "own" }, snapshot).ok).toBe(false);
  });

  it("refuses to change a fixed baseline", () => {
    expect(validateRoleSubmission("practitioner", { "appt.view_calendar": "off" }, snapshot).ok).toBe(false);
  });
});
