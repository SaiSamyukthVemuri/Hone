import { describe, expect, it } from "vitest";
import { CATALOG, effectiveScope, FIXED_OWNER_ONLY, ROLES, type PermissionDef, type StudioPolicy } from "@/lib/permissions/catalog";
import { applyEdit, buildRoleModel, buildRoleSections, groupLabel, WIDENING_LATER_LINE } from "@/lib/settings/roles/model";
import { COMMON_KEYS } from "@/lib/settings/roles/sections";
import { defaultsPolicy, diffPolicies, releaseNarrowings } from "@/lib/settings/roles/diff";
import { SECTIONS, sectionKeys, sectionOfGroup } from "@/lib/settings/roles/sections";

const defs = CATALOG as readonly PermissionDef[];
const snapshot: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };

// Enforcement is catalog truth (#1341's TypeScript catalog), so these tests set it on the entry for the duration of one render and put it back.
const withEnforcement = <T,>(map: Record<string, unknown>, fn: () => T): T => {
  const saved = new Map<string, unknown>();
  for (const [k, v] of Object.entries(map)) {
    const d = CATALOG.find((x) => x.key === k) as { enforcement?: unknown } | undefined;
    if (!d) throw new Error(`no catalog key ${k}`);
    saved.set(k, d.enforcement);
    d.enforcement = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) (CATALOG.find((x) => x.key === k) as { enforcement?: unknown }).enforcement = v;
  }
};

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
    withEnforcement({ "appt.move": "enforced", "appt.reassign": "enforced" }, () => {
      const withMove = applyEdit("practitioner", snapshot, "appt.move", "studio");
      if (!withMove.ok) throw new Error(withMove.reason);
      const edit = applyEdit("practitioner", withMove.policy, "appt.reassign", "studio");
      if (!edit.ok) throw new Error(edit.reason);
      expect(Object.keys(edit.policy.values).sort()).toEqual(["appt.move", "appt.reassign"]);
      expect(withMove.policy.values).toEqual({ "appt.move": "studio" }); // the move edit changed only that key
    });
  });

  it("turning a prerequisite Off keeps dependents' stored values but they stop being in force, and the page says so", () => {
    withEnforcement({ "appt.move": "enforced", "appt.reassign": "enforced" }, () => {
      const withMove = applyEdit("practitioner", snapshot, "appt.move", "studio");
      if (!withMove.ok) throw new Error(withMove.reason);
      const withReassign = applyEdit("practitioner", withMove.policy, "appt.reassign", "studio");
      if (!withReassign.ok) throw new Error(withReassign.reason);
      const lowered = applyEdit("practitioner", withReassign.policy, "appt.move", "off");
      if (!lowered.ok) throw new Error(lowered.reason);
      const row = buildRoleModel("practitioner", lowered.policy).flatMap((g) => g.rows).find((r) => r.key === "appt.reassign")!;
      expect(row.chosen).toBe("studio");
      expect(row.effective).toBe("off");
      expect(row.inactiveBecause).toMatch(/Move appointments/);
    });
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

describe("an 'Own assigned' option always shows what 'own' means (Sam batch 1, Q6)", () => {
  it("every practitioner row that offers Own carries the catalog's definition, so the owner reads it beside the scope", () => {
    for (const row of buildRoleModel("practitioner", snapshot).flatMap((g) => g.rows)) {
      if (row.options.some((o) => o.scope === "own")) expect(row.ownMeaning, row.key).toBeTruthy();
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



describe("the eight sections (presentation only)", () => {
  it("there are eight, and every catalog key is in exactly one", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(["appointments", "availability", "clients", "clinical", "payments", "pricing_reports", "communications", "operations"]);
    const all = Object.values(sectionKeys()).flat();
    expect(all.sort()).toEqual(defs.map((d) => d.key).sort());
    expect(new Set(all).size).toBe(all.length);
  });
  it("every catalog group is placed on purpose, none falls to the default", () => {
    for (const g of new Set(defs.map((d) => d.group))) {
      const placed = SECTIONS.some((s) => (s.groups as readonly string[]).includes(g));
      expect(placed, g).toBe(true);
    }
    expect(sectionOfGroup("something_new")).toBe("operations");
  });
  it("a row is common only when it is a listed headline capability and not fixed, gated or awaiting a decision", () => {
    for (const role of ROLES) {
      for (const row of buildRoleModel(role, snapshot).flatMap((g) => g.rows)) {
        const held = row.locked !== null || row.pendingDecision || Boolean(row.gateNote) || Boolean(row.heldUntil);
        if (!row.advanced) {
          expect(COMMON_KEYS.has(row.key), `${role} ${row.key} is common only if listed`).toBe(true);
          expect(held, `${role} ${row.key} is held, so it belongs under Advanced`).toBe(false);
        }
        if (row.advanced) expect(!COMMON_KEYS.has(row.key) || held, `${role} ${row.key}`).toBe(true);
      }
    }
  });
  it("every listed common key exists in the catalog, and each section keeps at least one common row, with the page well under a wall of controls", () => {
    for (const k of COMMON_KEYS) expect(defs.some((d) => d.key === k), k).toBe(true);
    const sections = buildRoleSections("practitioner", snapshot);
    for (const sec of sections) expect(sec.common.length, sec.id).toBeGreaterThan(0);
    const common = sections.reduce((n, sec) => n + sec.common.length, 0);
    expect(common).toBeLessThanOrEqual(40);
  });
  it("receptionist rows that the catalog does not offer say so and have no live control", () => {
    for (const row of buildRoleModel("receptionist", snapshot).flatMap((g) => g.rows)) {
      const d = defs.find((x) => x.key === row.key)!;
      if (!d.offeredTo.receptionist && d.ownerConfigurable) {
        expect(row.locked, row.key).toMatch(/Not offered to receptionists/);
        expect(row.options.every((o) => o.disabled), row.key).toBe(true);
      }
    }
  });
  it("consequence labels are specific: financial for money keys, sensitive for private data, never on an ordinary key", () => {
    for (const row of buildRoleModel("practitioner", snapshot).flatMap((g) => g.rows)) {
      const d = defs.find((x) => x.key === row.key)!;
      if (!d.sensitive) expect(row.consequence, row.key).toBeNull();
      else expect(row.consequence, row.key).toBe(d.group === "payments" || d.group === "pricing" ? "financial" : "sensitive");
    }
  });
});

describe("deny_only: set at or below the baseline, never above it (truth test both ways)", () => {
  const snapshot: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
  const def = (CATALOG as readonly PermissionDef[]).find((d) => d.key === "appt.move")!;
  const map = { "appt.move": "deny_only" };
  const rowOf = (policy: StudioPolicy) => withEnforcement(map, () => buildRoleModel("practitioner", policy)).flatMap((g) => g.rows).find((r) => r.key === "appt.move")!;
  const edit = (policy: StudioPolicy, scope: string, m: Record<string, unknown> = map) => withEnforcement(m, () => applyEdit("practitioner", policy, "appt.move", scope as never));
  it("narrowing below the baseline is allowed", () => {
    const r = edit(snapshot, "off");
    expect(r.ok).toBe(true);
  });
  it("every option wider than the baseline is disabled with the later-release line; the baseline itself is not", () => {
    const row = rowOf(snapshot);
    const base = def.existingSnapshot.practitioner;
    const rank = (s: string) => ["off", "own", "studio"].indexOf(s);
    for (const o of row.options) {
      if (o.selected) continue;
      if (rank(o.scope) > rank(base)) {
        expect(o.disabled, o.scope).toBe(true);
        expect(o.reason).toBe(WIDENING_LATER_LINE);
        expect(edit(snapshot, o.scope)).toEqual({ ok: false, reason: WIDENING_LATER_LINE });
      } else {
        expect(o.reason, o.scope).not.toBe(WIDENING_LATER_LINE);
      }
    }
  });
  it("an enforced key may be widened as before", () => {
    const widen = edit({ ...snapshot, values: { "appt.move": "off" } }, "studio", { "appt.move": "enforced" });
    expect(widen.ok).toBe(true);
  });
});
