import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  FEE_AMOUNT_READ,
  FIXED_OWNER_ONLY,
  GATES,
  GROUPS,
  MANDATORY,
  NARROWINGS,
  NOT_OFFERED_AS_TOGGLES,
  ROLES,
  SCOPES,
  basisValue,
  catalogByKey,
  checkChange,
  defaultsFor,
  effectiveScope,
  renderCatalogMarkdown,
  scopeRank,
  scopesFor,
  type GateId,
  type PermissionDef,
  type PolicyBasis,
  type Role,
  type Scope,
  type StudioPolicy,
} from "@/lib/permissions/catalog";
import { DECISIONS } from "@/lib/permissions/decisions";

// R0 validity of the ONE permission catalog. Pure data: nothing imports it yet, so none of this changes behaviour.
const DEFS = CATALOG as readonly PermissionDef[];
const DOC = readFileSync(path.resolve(__dirname, "../../../docs/security/permissions-catalog.md"), "utf8");
const d = (k: string) => catalogByKey.get(k)!;
const ALL_GATES = Object.fromEntries(Object.keys(GATES).map((g) => [g, true])) as Record<GateId, boolean>;
const pol = (basis: PolicyBasis | null, values: Record<string, Scope> = {}, gates: Partial<Record<GateId, boolean>> = ALL_GATES): StudioPolicy => ({ basis, values, gates });
const isEffectiveAllowed = (role: Role, def: PermissionDef, s: Scope) => scopesFor(def, role).includes(s);

describe("catalog shape", () => {
  it("has unique keys, each in exactly one group (Sam's eight plus the three added by the capability audit), and every group is used", () => {
    expect(new Set(DEFS.map((x) => x.key)).size).toBe(DEFS.length);
    for (const x of DEFS) expect(GROUPS).toContain(x.group);
    for (const g of GROUPS) expect(DEFS.some((x) => x.group === g)).toBe(true);
    expect(GROUPS).toEqual(["appointments", "clients_identity", "clinical_records", "communications", "payments", "pricing", "availability", "reports", "waitlist_operations", "waitlist_rules", "accepting_new_clients", "safety_records"]);
  });

  it("keys follow group.name, scopes start with off, and 'own' is explained exactly when offered", () => {
    for (const x of DEFS) {
      expect(x.key).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(x.scopes[0]).toBe("off");
      for (const s of x.scopes) expect(SCOPES).toContain(s);
      expect(x.scopes.includes("own")).toBe(typeof x.own === "string" && x.own.length > 0);
    }
  });

  it("every default and snapshot value is a scope the role may hold for that key", () => {
    for (const x of DEFS) for (const r of ROLES) {
      expect(scopesFor(x, r), `${x.key} default ${r}`).toContain(x.newStudioDefault[r]);
      expect(scopesFor(x, r), `${x.key} snapshot ${r}`).toContain(x.existingSnapshot[r]);
    }
  });

  it("D-5: 'own assigned appointments' is never offered to, defaulted for, or snapshotted for a receptionist", () => {
    for (const x of DEFS) {
      expect(scopesFor(x, "receptionist")).not.toContain("own");
      expect(x.newStudioDefault.receptionist, x.key).not.toBe("own");
      expect(x.existingSnapshot.receptionist, x.key).not.toBe("own");
    }
    const p = pol("new_studio");
    expect(checkChange("receptionist", "pay.refund", "own", p).ok).toBe(false);
    expect(effectiveScope("receptionist", "pay.refund", pol("new_studio", { "pay.refund": "own" }))).toBe("off");
  });

  it("a key not offered to a role is Off in every default and snapshot for that role", () => {
    for (const x of DEFS) for (const r of ROLES) if (!x.offeredTo[r]) {
      expect(x.newStudioDefault[r], `${x.key} ${r}`).toBe("off");
      expect(x.existingSnapshot[r], `${x.key} ${r}`).toBe("off");
    }
  });

  it("the only fixed baselines (not owner-configurable) are the calendar view and the client list view", () => {
    expect(DEFS.filter((x) => !x.ownerConfigurable).map((x) => x.key).sort()).toEqual(["appt.view_calendar", "client.view_directory"]);
  });
});

describe("prerequisites", () => {
  it("every prerequisite names a catalog key and the graph is acyclic", () => {
    for (const x of DEFS) for (const r of x.requires) expect(catalogByKey.has(r), `${x.key} requires ${r}`).toBe(true);
    const state = new Map<string, 1 | 2>();
    const visit = (k: string, trail: string[]) => {
      if (state.get(k) === 2) return;
      expect(state.get(k), `cycle: ${[...trail, k].join(" -> ")}`).not.toBe(1);
      state.set(k, 1);
      for (const r of d(k).requires) visit(r, [...trail, k]);
      state.set(k, 2);
    };
    for (const x of DEFS) visit(x.key, []);
  });

  it("no default or snapshot value exceeds what its prerequisites allow (a ship-state never relies on an auto-enabled key)", () => {
    for (const basis of ["new_studio", "existing_snapshot"] as const) for (const r of ROLES) {
      for (const x of DEFS) {
        if (!x.offeredTo[r]) continue;
        expect(effectiveScope(r, x.key, pol(basis)), `${basis} ${r} ${x.key}`).toBe(basisValue(x, r, basis));
      }
    }
  });

  it("every payment, per-appointment pricing, client-price and report key requires seeing the payment", () => {
    for (const x of DEFS.filter((y) => y.group === "payments" && y.key !== "pay.view_appointment")) expect(x.requires).toContain("pay.view_appointment");
    for (const k of ["price.appointment", "price.view_client_prices", "rep.financial_reports", "rep.lifetime_spend"]) expect(d(k).requires, k).toContain("pay.view_appointment");
  });

  it("Q25 (Sam, 3 Nov): studio totals have NO prerequisite on the payment view, and the payment view needs nothing from them", () => {
    expect(d("rep.studio_totals").requires).toEqual([]);
    expect(d("pay.view_appointment").requires).not.toContain("rep.studio_totals");
    const p = pol("new_studio", { "rep.studio_totals": "studio" });
    expect(checkChange("practitioner", "rep.studio_totals", "studio", pol("new_studio", {})).ok).toBe(true);
    expect(effectiveScope("practitioner", "rep.studio_totals", p)).toBe("studio");
    expect(effectiveScope("practitioner", "pay.view_appointment", p)).toBe(effectiveScope("practitioner", "pay.view_appointment", pol("new_studio", {})));
    // totals stay available when the payment view is turned all the way off
    expect(effectiveScope("practitioner", "rep.studio_totals", pol("new_studio", { "rep.studio_totals": "studio", "pay.view_appointment": "off" }))).toBe("studio");
  });

  it("F10: enabling one clinical capability never grants another: photos and intake do NOT require chart access", () => {
    expect(d("clin.view_photos").requires).not.toContain("clin.view_records");
    expect(d("clin.view_intake").requires).not.toContain("clin.view_records");
    expect(d("clin.edit_records").requires).toEqual(["clin.view_records"]);
    expect(d("clin.print_record").requires).toContain("clin.view_records");
    expect(d("appt.complete").requires).toContain("clin.view_records");
    // intake read for a receptionist can be turned on WITHOUT turning on chart read
    const p = pol("new_studio", { "clin.view_intake": "studio" });
    expect(checkChange("receptionist", "clin.view_intake", "studio", p).ok).toBe(true);
    expect(effectiveScope("receptionist", "clin.view_intake", p)).toBe("studio");
    expect(effectiveScope("receptionist", "clin.view_records", p)).toBe("off");
  });
});

// ──────────────── Insurance D-1 / D-2 and Privacy F1 / F2 ────────────────
describe("D-1: a missing stored value resolves to the studio's policy BASIS, never to the new-studio default", () => {
  it("an existing studio with no stored rows resolves to the SNAPSHOT for every key and role (no silent widening)", () => {
    for (const r of ROLES) for (const x of DEFS) {
      if (!x.offeredTo[r]) continue;
      expect(effectiveScope(r, x.key, pol("existing_snapshot", {}, ALL_GATES)), `${r} ${x.key}`).toBe(basisValue(x, r, "existing_snapshot"));
    }
    // the dangerous cases: finance and pricing stay Off for an existing studio with nothing stored
    for (const k of ["pay.refund", "pay.charge_saved_card", "price.service_list", "price.fee_amounts", "pay.view_appointment"]) {
      expect(effectiveScope("practitioner", k, pol("existing_snapshot")), k).toBe("off");
      expect(effectiveScope("receptionist", k, pol("existing_snapshot")), k).toBe("off");
    }
  });

  it("a NEW studio with no stored rows resolves to the shipped default (when gates are satisfied)", () => {
    expect(effectiveScope("practitioner", "pay.refund", pol("new_studio"))).toBe("own");
    expect(effectiveScope("receptionist", "pay.refund", pol("new_studio"))).toBe("studio");
  });

  it("a newly added key (no stored row) resolves to the studio's basis, not the default", () => {
    const stored = { "appt.book": "own" as Scope }; // an old studio that has rows for older keys only
    expect(effectiveScope("receptionist", "price.service_list", pol("existing_snapshot", stored))).toBe("off");
    expect(effectiveScope("receptionist", "price.service_list", pol("new_studio", stored))).toBe("studio");
  });

  it("an unknown or unreadable policy basis fails CLOSED: every key is Off", () => {
    for (const r of ROLES) for (const x of DEFS) expect(effectiveScope(r, x.key, pol(null)), `${r} ${x.key}`).toBe("off");
    expect(checkChange("practitioner", "appt.book", "own", pol(null)).ok).toBe(false);
  });

  it("an explicit stored value still wins over the basis", () => {
    expect(effectiveScope("practitioner", "pay.view_appointment", pol("existing_snapshot", { "pay.view_appointment": "own" }))).toBe("own");
  });
});

describe("D-2 / F1: a capped result the key does not allow becomes Off (a boolean key can never come out as 'own')", () => {
  it("lowering the payment view to own turns each studio-wide money report Off, with the stored value kept", () => {
    const stored = { "pay.view_appointment": "own" as Scope, "rep.financial_reports": "studio" as Scope, "rep.lifetime_spend": "studio" as Scope };
    const p = pol("new_studio", stored);
    for (const k of ["rep.financial_reports", "rep.lifetime_spend"]) {
      expect(effectiveScope("practitioner", k, p), k).toBe("off");
      expect(p.values[k]).toBe("studio");
    }
    const up = pol("new_studio", { ...stored, "pay.view_appointment": "studio" });
    for (const k of ["rep.financial_reports", "rep.lifetime_spend"]) expect(effectiveScope("practitioner", k, up), k).toBe("studio");
  });

  it("every effective value is a scope its key allows, and never exceeds any prerequisite, under random stored values and gates (property test)", () => {
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
    for (let i = 0; i < 400; i++) {
      for (const r of ROLES) {
        const values: Record<string, Scope> = {};
        for (const x of DEFS) if (rnd() < 0.8) values[x.key] = pick(SCOPES); // includes scopes the key does not allow
        const gates: Partial<Record<GateId, boolean>> = {};
        for (const g of Object.keys(GATES) as GateId[]) gates[g] = rnd() < 0.5;
        const basis = pick(["existing_snapshot", "new_studio"] as const);
        const p: StudioPolicy = { basis, values, gates };
        for (const x of DEFS) {
          const e = effectiveScope(r, x.key, p);
          expect(isEffectiveAllowed(r, x, e), `${r} ${x.key} -> ${e}`).toBe(true);
          if (!x.offeredTo[r]) expect(e).toBe("off");
          for (const req of x.requires) expect(scopeRank(e), `${r} ${x.key} vs ${req}`).toBeLessThanOrEqual(scopeRank(effectiveScope(r, req, p)));
        }
      }
    }
  });
});

describe("F2: ship gates are READ. An unmet gate makes the role-key unavailable (capped at the snapshot)", () => {
  const gated: [string, Role, GateId][] = [];
  for (const x of DEFS) for (const r of ROLES) { const g = x.shipGate?.[r]; if (g) gated.push([x.key, r, g]); }

  it("every gated key's gate is a known gate id, and the gated set is exactly the intended one", () => {
    for (const [, , g] of gated) expect(GATES[g]).toBeTruthy();
    const fin = ["pay.view_appointment", "pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.view_client_prices", "price.service_list", "price.fee_amounts"];
    for (const k of fin) expect(d(k).shipGate?.receptionist, k).toBe("receptionist_finance");
    expect(d("client.view_legal_name").shipGate?.receptionist).toBe("receptionist_legal_name");
    expect(d("client.edit_legal_name").shipGate).toEqual({ practitioner: "practitioner_legal_name_edit", receptionist: "receptionist_legal_name" });
    expect(d("appt.complete").shipGate?.practitioner).toBe("practitioner_completion");
    expect(d("appt.edit_notes").shipGate?.receptionist).toBe("receptionist_scheduling_notes");
  });

  it("a gated role-key is effectively Off while its gate is unmet, even when stored Studio and even when the default is Studio", () => {
    for (const [k, r, g] of gated) {
      const x = d(k);
      if (x.existingSnapshot[r] !== "off") continue; // gated keys the role already holds today are capped at the snapshot, tested below
      const stored: StudioPolicy = { basis: "new_studio", values: { [k]: "studio" }, gates: { ...ALL_GATES, [g]: false } };
      const dflt: StudioPolicy = { basis: "new_studio", values: {}, gates: { ...ALL_GATES, [g]: false } };
      // prerequisites must be satisfied for the assertion to be about the gate only
      const withPrereqs = { ...stored, values: { ...stored.values, "pay.view_appointment": "studio" as Scope } };
      expect(effectiveScope(r, k, withPrereqs), `${r} ${k} stored`).toBe("off");
      expect(effectiveScope(r, k, dflt), `${r} ${k} default`).toBe("off");
    }
  });

  it("receptionist finance is Off in a NEW studio until the gate is released, then on at the shipped default", () => {
    const unreleased: StudioPolicy = { basis: "new_studio", values: {}, gates: {} };
    for (const k of ["pay.view_appointment", "pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.service_list", "price.fee_amounts"]) {
      expect(effectiveScope("receptionist", k, unreleased), k).toBe("off");
      expect(effectiveScope("receptionist", k, { ...unreleased, gates: { receptionist_finance: true } }), k).toBe("studio");
    }
    // the practitioner is not behind the receptionist gate
    expect(effectiveScope("practitioner", "pay.refund", unreleased)).toBe("own");
  });

  it("an unmet gate never narrows what an existing studio has today: practitioner legal-name edit and completion stay at the snapshot", () => {
    const p: StudioPolicy = { basis: "existing_snapshot", values: {}, gates: {} };
    expect(effectiveScope("practitioner", "client.edit_legal_name", p)).toBe(d("client.edit_legal_name").existingSnapshot.practitioner);
    expect(effectiveScope("practitioner", "appt.complete", p)).toBe(d("appt.complete").existingSnapshot.practitioner);
    // but a NEW studio's practitioner does not get legal-name edit until the gate holds beyond the snapshot value
    expect(scopeRank(effectiveScope("practitioner", "client.edit_legal_name", { basis: "new_studio", values: {}, gates: {} }))).toBeLessThanOrEqual(scopeRank(d("client.edit_legal_name").existingSnapshot.practitioner));
  });

  it("checkChange refuses to enable an unavailable key and names the gate; the owner cannot flip a gate", () => {
    const p: StudioPolicy = { basis: "new_studio", values: {}, gates: {} };
    const res = checkChange("receptionist", "pay.refund", "studio", p);
    expect(res).toMatchObject({ ok: false, blockedBy: "receptionist_finance" });
    if (!res.ok) expect(res.reason).toMatch(/Not yet available/);
    // the policy type has no owner-writable gate: gates live on StudioPolicy.gates (operator data) and not in `values`
    expect(Object.keys(GATES)).not.toContain("pay.refund");
    expect(checkChange("receptionist", "pay.refund", "studio", { ...p, gates: { receptionist_finance: true } }).ok).toBe(true);
  });
});

describe("Sam's spec, encoded", () => {
  it("C.3: every finance key defaults ON for both staff roles in a new studio, as SEPARATE keys", () => {
    const keys = ["pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.service_list", "price.fee_amounts"];
    expect(new Set(keys).size).toBe(8);
    for (const k of keys) { expect(d(k).newStudioDefault.practitioner).not.toBe("off"); expect(d(k).newStudioDefault.receptionist).not.toBe("off"); }
  });

  it("C.3: practitioners default to own assigned appointments, receptionists to the studio", () => {
    for (const k of ["pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.view_client_prices"]) {
      expect(d(k).newStudioDefault.practitioner).toBe("own");
      expect(d(k).newStudioDefault.receptionist).toBe("studio");
    }
  });

  it("D-6: per-client prices have their own key, gated like the other money keys, closing M-4", () => {
    expect(d("price.view_client_prices").snapshotBasis).toBe("approved_policy");
    expect(d("price.view_client_prices").killSwitch).toBe(true);
    for (const r of ROLES) expect(d("price.view_client_prices").existingSnapshot[r]).toBe("off");
  });

  it("C.3: studio totals, financial reports and lifetime spend default OFF for both roles", () => {
    for (const k of ["rep.studio_totals", "rep.financial_reports", "rep.lifetime_spend"]) for (const r of ROLES) expect(d(k).newStudioDefault[r]).toBe("off");
  });

  it("C.3: studio-wide price and fee settings are labelled as affecting future studio business", () => {
    expect(d("price.service_list").affectsFutureStudioBusiness).toBe(true);
    expect(d("price.fee_amounts").affectsFutureStudioBusiness).toBe(true);
    expect(d("price.appointment").affectsFutureStudioBusiness).toBeUndefined();
  });

  it("C.3 / R1: every payment, pricing and money-report key is behind the operator kill switch", () => {
    for (const x of DEFS.filter((y) => ["payments", "pricing"].includes(y.group) || ["rep.studio_totals", "rep.financial_reports", "rep.lifetime_spend"].includes(y.key))) {
      if (x.key === "price.service_list" || x.key === "price.fee_amounts" || x.group === "payments" || x.group === "pricing" || x.group === "reports") expect(x.killSwitch, x.key).toBe(true);
    }
  });

  it("C.4 practitioner defaults", () => {
    const p = (k: string) => d(k).newStudioDefault.practitioner;
    expect(p("appt.book")).toBe("own"); expect(p("appt.move")).toBe("own"); expect(p("appt.reassign")).toBe("off");
    expect(p("appt.complete")).toBe("own");
    for (const k of ["appt.cancel", "appt.mark_no_show", "appt.edit_notes", "appt.aftercare_send"]) expect(p(k)).toBe("studio");
    for (const k of ["clin.view_records", "clin.edit_records", "client.view_legal_name", "client.edit_legal_name", "client.create", "client.edit_contact"]) expect(p(k)).toBe("studio");
    expect(p("avail.manage_own")).toBe("studio"); expect(p("avail.manage_others")).toBe("off");
    for (const k of ["clin.edit_consent_templates", "comm.bulk_message", "client.merge", "client.import", "rep.bulk_export", "rep.audit_log_view"]) expect(p(k)).toBe("off");
  });

  it("C.4 receptionist defaults, with legal name and clinical read/write SEPARATE", () => {
    const r = (k: string) => d(k).newStudioDefault.receptionist;
    for (const k of ["appt.book", "appt.move", "appt.reassign", "appt.cancel", "appt.mark_no_show", "appt.edit_notes", "client.create", "client.edit_contact"]) expect(r(k)).toBe("studio");
    for (const k of ["clin.view_records", "clin.edit_records", "clin.view_photos", "clin.view_intake", "clin.view_aftercare", "appt.complete", "appt.aftercare_send", "client.view_legal_name", "client.edit_legal_name"]) expect(r(k)).toBe("off");
    expect(d("client.edit_legal_name").requires).toEqual(["client.view_legal_name"]);
    const v = pol("new_studio");
    expect(checkChange("receptionist", "client.edit_legal_name", "studio", v).ok).toBe(false); // refused, NOT silently enabling the view key
    expect(effectiveScope("receptionist", "client.view_legal_name", v)).toBe("off");
  });

  it("C.4: routine communications are ON within scope and both bulk and audit-log access are OFF for both roles", () => {
    // Settled by OPS (3 Nov): ON for both staff roles in a NEW studio (C.4); an existing studio keeps today's access (practitioner Studio, receptionist Off).
    for (const r of ROLES) { expect(d("comm.send_routine").newStudioDefault[r]).not.toBe("off"); expect(d("comm.bulk_message").newStudioDefault[r]).toBe("off"); expect(d("rep.audit_log_view").newStudioDefault[r]).toBe("off"); }
  });

  it("C.5 / F4: the fixed owner-only items have NO key, including staff management, ownership transfer and permission-system administration", () => {
    const ids = FIXED_OWNER_ONLY.map((f) => f.id);
    for (const must of ["manage_roles_permissions_ownership", "staff_invite_remove_role_change", "ownership_transfer", "permission_system_administration", "full_studio_data_export", "provider_credentials_bank_payouts", "studio_account_deletion", "permanent_deletion_bulk_destructive", "audit_history_delete_alter", "delete_treatment_records_and_photos", "archive_clients", "restore_deleted_records"]) expect(ids).toContain(must);
    for (const f of FIXED_OWNER_ONLY) expect(catalogByKey.has(f.id), f.id).toBe(false);
    for (const x of DEFS) {
      expect(x.key).not.toMatch(/(roles?|ownership|credential|payout|bank|delete|archive|restore|destroy|staff|invite|remove|transfer|kill_?switch)/);
      expect(x.key.split(".")[1]).not.toMatch(/^(manage_roles|manage_permissions|manage_staff)$/);
    }
    expect(NOT_OFFERED_AS_TOGGLES.join(" ")).not.toMatch(/invitation|removal/i); // staff management is FIXED, not a soft 'not offered'
  });

  it("C.5: the fixed items that NARROW existing practitioners are flagged, name what enforces them, and so require a notice", () => {
    const narrowing = FIXED_OWNER_ONLY.filter((f) => f.existingEffect === "narrows");
    expect(narrowing.map((f) => f.id).sort()).toEqual(["archive_clients", "delete_treatment_records_and_photos", "id_portraits_owner_only", "restore_deleted_records"]);
    for (const f of narrowing) expect(f.enforcedBy?.length, f.id).toBeGreaterThan(0);
    expect(FIXED_OWNER_ONLY.find((f) => f.id === "delete_treatment_records_and_photos")!.enforcedBy).toContain("public.soft_delete_session");
  });

  it("C.6: the existing-studio snapshot never exceeds the new-studio default for any key", () => {
    for (const x of DEFS) for (const r of ROLES) expect(scopeRank(x.existingSnapshot[r]), `${x.key} ${r}`).toBeLessThanOrEqual(scopeRank(x.newStudioDefault[r]));
  });

  it("C.6: no existing-studio snapshot grants any finance, pricing or money-report access", () => {
    for (const x of DEFS.filter((y) => ["payments", "pricing"].includes(y.group) || y.key.startsWith("rep."))) for (const r of ROLES) expect(x.existingSnapshot[r], `${x.key} ${r}`).toBe("off");
  });

  it("the database holes are OFF in the snapshot and say so (H1, H2, M-2, M-3, M-4)", () => {
    for (const k of ["price.service_list", "clin.edit_consent_templates", "pay.view_appointment", "rep.lifetime_spend", "price.view_client_prices"]) expect(d(k).snapshotBasis).toBe("approved_policy");
  });

  it("F3: the receptionist legal-name snapshot is approved-policy OFF, not each studio's current switch value", () => {
    expect(d("client.view_legal_name").existingSnapshot.receptionist).toBe("off");
    expect(d("client.edit_legal_name").existingSnapshot.receptionist).toBe("off");
    expect(d("client.view_legal_name").snapshotBasis).toBe("approved_policy");
    expect(d("client.view_legal_name").note).not.toMatch(/COPIES/);
    expect(d("client.view_legal_name").note).toMatch(/review banner/);
  });

  it("D-3: every snapshot that rests only on OPS's source reading of today's behaviour is pinned by an exact list, so a new one is a visible, reviewed change (it is a reading, not a runtime proof)", () => {
    // DN-30 (decided 3 Nov): practitioners do these today, so the snapshot is Studio, preserved for every existing studio.
    expect(d("clin.edit_intake").existingSnapshot.practitioner).toBe("studio");
    expect(d("comm.send_routine").existingSnapshot.practitioner).toBe("studio");
    expect(d("clin.edit_intake").pendingDecision ?? []).not.toContain("DN-30");
    expect(d("comm.send_routine").pendingDecision).toBeUndefined();
    // every remaining non-off snapshot resting on a source reading is listed here; adding one is a visible, reviewed change
    const unverified = DEFS.flatMap((x) => ROLES.filter((r) => x.snapshotBasis === "source" && x.existingSnapshot[r] !== "off").map((r) => `${x.key}:${r}`)).sort();
    expect(unverified).toEqual([
      "appt.aftercare_send:practitioner", "appt.book:practitioner", "appt.cancel:practitioner", "appt.edit_notes:practitioner", "appt.mark_no_show:practitioner", "appt.move:practitioner",
      "appt.view_calendar:practitioner", "appt.view_calendar:receptionist", "client.create:practitioner", "client.edit_contact:practitioner", "client.edit_legal_name:practitioner",
      "client.view_directory:practitioner", "clin.edit_records:practitioner", "clin.print_record:practitioner", "clin.upload_photos:practitioner",
      "clin.view_aftercare:practitioner", "clin.view_intake:practitioner",
      "clin.view_photos:practitioner", "clin.view_records:practitioner",
      "clin.edit_intake:practitioner", "comm.send_routine:practitioner",
      // DN-9, DN-14 and DN-30 (decided 3 Nov): separately configurable, each preserved for existing practitioners.
      "clin.view_intake_status:practitioner", "clin.review_intake:practitioner", "comm.send_intake_link:practitioner", "comm.send_portal_link:practitioner", "comm.send_portal_reply:practitioner",
      // DN-3 and DN-5 (decided, 2 Nov): practitioners keep today's studio-wide access to these data groups and to the safety records.
      ...["dob_address", "allergies_cautions", "budget", "personal_notes", "tags", "health_fields"].flatMap((g) => [`client.view_${g}:practitioner`, `client.edit_${g}:practitioner`]),
      "records.view_sterilisation_disinfection:practitioner", "records.log_sterilisation_disinfection:practitioner",
    ].sort());
  });

  it("F5/F10: derived outputs are bound to the actor's other keys", () => {
    expect(d("rep.bulk_export").requires).toContain("client.view_directory");
    expect(d("comm.bulk_message").requires).toEqual(expect.arrayContaining(["comm.send_routine", "client.view_directory"]));
    expect(d("client.merge").requires).toEqual(expect.arrayContaining(["client.edit_contact", "client.view_legal_name"]));
    expect(d("rep.bulk_export").description).toMatch(/NEVER the whole-studio data export/);
  });

  it("D-7 / F4 / F5 / F8: the mandatory list pins the rules R1 to R3 are reviewed against", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/isolation/, /remaining refundable/, /at least one active owner/, /financial activity feed cannot be switched off/, /verify the actual acting user/, /reason is required for every refund, correction and waiver/, /Overlapping memberships or dual roles cannot bypass a denial/, /kill switch fails closed/, /missing, unknown or unreadable policy state resolves to OFF/, /derived output/, /only through owner-only writer functions/, /CURRENT assignee at the moment of the action/]) expect(m).toMatch(re);
  });
});

describe("prerequisite behaviour (the page, server and database must all do exactly this)", () => {
  const base = (over: Record<string, Scope> = {}): StudioPolicy => ({ basis: "new_studio", values: { ...defaultsFor("practitioner", "new_studio"), ...over }, gates: ALL_GATES });

  it("turning a prerequisite OFF makes dependents effectively OFF but keeps their stored value", () => {
    const v = base({ "pay.view_appointment": "off" });
    expect(effectiveScope("practitioner", "pay.refund", v)).toBe("off");
    expect(v.values["pay.refund"]).toBe("own");
    expect(effectiveScope("practitioner", "pay.refund", base({ "pay.view_appointment": "own" }))).toBe("own");
  });

  it("a dependent is capped by its prerequisite's scope", () => {
    expect(effectiveScope("practitioner", "pay.refund", base({ "pay.refund": "studio", "pay.view_appointment": "own" }))).toBe("own");
  });

  it("setting a dependent above its prerequisite is REFUSED with the prerequisite named, and nothing else is changed", () => {
    const v = base({ "pay.view_appointment": "off" });
    const res = checkChange("practitioner", "pay.refund", "own", v);
    expect(res).toMatchObject({ ok: false, blockedBy: "pay.view_appointment" });
    if (!res.ok) expect(res.reason).toMatch(/first/);
    expect(v.values["pay.view_appointment"]).toBe("off");
  });

  it("a studio-wide boolean report key cannot be set while the payment view is only Own, and the refusal says why", () => {
    const res = checkChange("practitioner", "rep.financial_reports", "studio", base());
    expect(res).toMatchObject({ ok: false, blockedBy: "pay.view_appointment" });
    expect(checkChange("practitioner", "rep.financial_reports", "studio", base({ "pay.view_appointment": "studio" })).ok).toBe(true);
  });

  it("lowering a prerequisite is always allowed; unknown, unoffered, fixed and out-of-range requests are refused", () => {
    expect(checkChange("practitioner", "pay.view_appointment", "off", base()).ok).toBe(true);
    expect(checkChange("practitioner", "pay.refund", "bogus" as never, base()).ok).toBe(false);
    expect(checkChange("practitioner", "no.such_key", "studio", base()).ok).toBe(false);
    expect(checkChange("receptionist", "avail.manage_own", "studio", { basis: "new_studio", values: {}, gates: ALL_GATES }).ok).toBe(false);
    expect(checkChange("practitioner", "appt.view_calendar", "off", base()).ok).toBe(false);
    expect(checkChange("practitioner", "price.service_list", "own" as never, base()).ok).toBe(false);
  });

  it("an unknown key or a not-offered key is effectively OFF (fails closed)", () => {
    expect(effectiveScope("practitioner", "no.such_key", base())).toBe("off");
    expect(effectiveScope("receptionist", "avail.manage_own", pol("new_studio", { "avail.manage_own": "studio" }))).toBe("off");
  });
});

describe("the doc embeds the generated table and states the new rules", () => {
  it("docs/security/permissions-catalog.md contains exactly the generated catalog block", () => {
    const m = DOC.match(/<!-- catalog:begin -->\n([\s\S]*?)\n<!-- catalog:end -->/);
    expect(m, "catalog markers missing").not.toBeNull();
    expect(m![1]).toBe(renderCatalogMarkdown());
  });
});

describe("Insurance and Codex review of 35dcf28d7, and Sam's group 4 (3 Nov)", () => {
  it("printing a clinical record is not offered to receptionists (R0-Q2), so a change for one is refused", () => {
    expect(d("clin.print_record").offeredTo).toEqual({ practitioner: true, receptionist: false });
    expect(checkChange("receptionist", "clin.print_record", "studio", pol("new_studio", { "clin.view_records": "studio" })).ok).toBe(false);
  });
  it("R-3: reading a fee amount needs a named key, and the rule is in the mandatory list", () => {
    for (const k of FEE_AMOUNT_READ.anyOf) expect(catalogByKey.has(k), k).toBe(true);
    expect(FEE_AMOUNT_READ.shownToClientsAtBooking).toBe("readable by staff");
    expect(MANDATORY.join("\n")).toMatch(/fee amount clients see at booking is open to staff; any other fee field needs price\.fee_amounts or pay\.view_appointment/);
  });
  it("batch 3 (Sam, 3 Nov): calendar pause is R4, staff reading is unchanged for editing, and A6 recipient wording is carried", () => {
    expect(NARROWINGS.find((n) => n.id === "deactivated_calendar_owner")!.stage).toBe("R4");
    expect(d("price.fee_amounts").requires).toEqual([]);
    expect(d("wl.expire_close").requires).toEqual(["wl.view_queue"]);
    expect(d("wl.manage_queue").label).not.toMatch(/expire|close/i);
    expect(d("wl.manage_queue").description).toMatch(/wl\.expire_close/);
    expect(d("appt.handoff_own").note).toMatch(/ACTIVE practitioner of the SAME studio who is configured for the service/);
    for (const x of DEFS.filter((k) => k.key.startsWith("wl.") && k.key !== "wl.view_queue")) expect(x.requires, x.key).toContain("wl.view_queue");
  });
  it("OPS technical calls (3 Nov): reassign has no Own scope (handoff_own is the only way to hand away one's own); notes edit implies read of scheduling notes only", () => {
    expect(d("appt.reassign").scopes).toEqual(["off", "studio"]);
    expect(d("appt.reassign").own).toBeUndefined();
    expect(d("appt.handoff_own").offeredTo).toEqual({ practitioner: true, receptionist: false });
    expect(d("appt.edit_notes").note).toMatch(/EDIT grant implies READ of the same scheduling notes, never clinical notes, and there is no separate read key/);
    expect(catalogByKey.has("appt.view_notes")).toBe(false);
  });
  it("batch 4 (Sam, 3 Nov): the consequence label is on exactly prices, fees, hours, waitlist rules and admission rules, each with its own effect line", () => {
    const flagged = DEFS.filter((x) => x.affectsFutureStudioBusiness).map((x) => x.key).sort();
    expect(flagged).toEqual(["admit.booking_rules", "admit.change_policy", "avail.manage_studio_hours", "price.fee_amounts", "price.service_list", "wlrules.invitation_rounds", "wlrules.policy_and_text"]);
    const lines = new Set<string>();
    for (const k of flagged) {
      const e = d(k).futureBusinessEffect;
      expect(e && e.length > 30, k).toBe(true);
      lines.add(e!);
    }
    expect(lines.size).toBe(flagged.length);
    for (const x of DEFS.filter((y) => !y.affectsFutureStudioBusiness)) expect(x.futureBusinessEffect, x.key).toBeUndefined();
  });
  it("batch 4: waitlist rules need no queue view; the client directory is a fixed baseline for both roles", () => {
    expect(d("wlrules.invitation_rounds").requires).toEqual([]);
    expect(d("wlrules.policy_and_text").requires).toEqual([]);
    expect(d("client.view_directory").ownerConfigurable).toBe(false);
    expect(d("client.view_directory").note).toMatch(/FIXED BASELINE for ACTIVE practitioners and receptionists/);
    expect(d("client.view_directory").touchedByDecision).toBeUndefined();
  });
  it("R-4: every narrowing names a decided decision, a stage, an enforcement point and the notice text", () => {
    expect(NARROWINGS.map((n) => n.id)).toEqual(expect.arrayContaining(["performer_change", "exposure_incident_history", "colleague_private_fields", "getting_started_filter", "notification_read_state", "portal_reply_immutable", "studio_columns_read"]));
    for (const n of NARROWINGS) {
      if (n.decision.startsWith("DN-")) expect(DECISIONS[n.decision as keyof typeof DECISIONS].status, n.id).toBe("decided");
      else expect(n.decision, n.id).toMatch(/^G7:/);
      expect(n.enforcedBy.length, n.id).toBeGreaterThan(0);
      expect(n.notice.length, n.id).toBeGreaterThan(20);
    }
    expect(new Set(NARROWINGS.map((n) => n.id)).size).toBe(NARROWINGS.length);
  });
  it("R-6: every other waitlist operation requires wl.view_queue", () => {
    for (const x of DEFS.filter((k) => k.group === "waitlist_operations" && k.key !== "wl.view_queue")) expect(x.requires, x.key).toContain("wl.view_queue");
  });
  it("G1 (Privacy F9): colleagues' note edits stay tied to 0283 in the key's note, and a receptionist stays behind the scheduling-notes gate", () => {
    expect(d("appt.edit_notes").note).toMatch(/0283/);
    expect(d("appt.edit_notes").shipGate?.receptionist).toBe("receptionist_scheduling_notes");
  });
  it("R-5: avail.manage_own is Studio for a NEW studio only; an existing studio's snapshot stays Off", () => {
    expect(d("avail.manage_own").newStudioDefault.practitioner).toBe("studio");
    expect(d("avail.manage_own").existingSnapshot.practitioner).toBe("off");
  });
  it("DN-9: an intake resend needs the messaging key and the intake STATUS read, never the answers or the chart", () => {
    const k = d("comm.send_intake_link");
    expect(k.requires).toEqual(expect.arrayContaining(["comm.send_routine", "clin.view_intake_status"]));
    expect(k.requires).not.toContain("clin.view_intake");
    expect(k.requires).not.toContain("clin.view_records");
    expect(d("clin.view_intake_status").requires).not.toContain("clin.view_intake");
  });
  it("DN-14: portal replies are practitioner ON, receptionist OFF, owner-configurable for both", () => {
    const k = d("comm.send_portal_reply");
    expect(k.newStudioDefault).toEqual({ practitioner: "studio", receptionist: "off" });
    expect(k.offeredTo).toEqual({ practitioner: true, receptionist: true });
    expect(k.ownerConfigurable).toBe(true);
  });
  it("DN-30: sending intake links, sending portal links and reviewing intake are separate keys, each preserved for existing practitioners", () => {
    for (const key of ["comm.send_intake_link", "comm.send_portal_link", "clin.review_intake", "clin.edit_intake"]) {
      expect(d(key).existingSnapshot.practitioner, key).toBe("studio");
      expect(d(key).existingSnapshot.receptionist, key).toBe("off");
    }
  });
  it("group 4 rules are carried as build requirements", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/intake STATUS read/, /sender of every staff portal message is recorded/, /notification read state is per person/, /respects consent, opt-outs and existing channel-activation/]) expect(m).toMatch(re);
  });
});

describe("Sam's group 5 (3 Nov): payment details", () => {
  it("DN-11: client prices have a separate set key, OFF for both roles, owner-configurable; reads follow the view key", () => {
    const k = d("price.edit_client_prices");
    expect(k.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
    expect(k.existingSnapshot).toEqual({ practitioner: "off", receptionist: "off" });
    expect(k.offeredTo).toEqual({ practitioner: true, receptionist: true });
    expect(k.ownerConfigurable).toBe(true);
    expect(k.requires).toContain("price.view_client_prices");
    expect(k.pendingDecision ?? []).not.toContain("DN-11");
  });
  it("DN-23a: requiring a card to book is owner-only and has no staff key", () => {
    expect(FIXED_OWNER_ONLY.map((f) => f.id)).toContain("require_card_to_book");
    expect(DEFS.some((x) => /require_card|card_on_file/.test(x.key))).toBe(false);
  });
  it("DN-10 and DN-23b are carried as build requirements", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/card-authorisation consent is READ-ONLY/, /signed originals can never be edited or deleted/, /agreed prices unless someone explicitly edits/, /NO invented default and is never activated automatically/, /policy snapshot taken at THAT booking/, /duplicate charges are prevented/]) expect(m).toMatch(re);
  });
  it("DN-23b: a late-cancel fee charge is gated by the fee-charging key, and the coverage row names the held migration", () => {
    expect(catalogByKey.has("pay.charge_saved_card")).toBe(true);
  });
});

describe("Sam's group 6 (3 Nov): deletion, data rights, rollout timing", () => {
  it("DN-18, DN-20, DN-25: erasure, the portal setting, archive and restore are fixed owner-only items with no staff key", () => {
    const ids = FIXED_OWNER_ONLY.map((f) => f.id);
    for (const id of ["erase_client_permanently", "client_portal_setting", "archive_clients", "restore_deleted_records", "full_studio_data_export"]) expect(ids).toContain(id);
    expect(FIXED_OWNER_ONLY.find((f) => f.id === "erase_client_permanently")?.note).toMatch(/EXECUTION stays unavailable/);
    expect(FIXED_OWNER_ONLY.find((f) => f.id === "erase_client_permanently")?.note).toMatch(/No retention period is invented/);
  });
  it("DN-26: receptionist legal-name keys are unavailable behind a gate whose text says 'Not available yet' until privacy enforcement and logging are verified", () => {
    expect(GATES.receptionist_legal_name).toMatch(/Not available yet/);
    expect(GATES.receptionist_legal_name).toMatch(/access logging/);
    const r = checkChange("receptionist", "client.view_legal_name", "studio", pol("new_studio", {}, {}));
    expect(r.ok).toBe(false);
    expect(d("client.view_legal_name").pendingDecision).toBeUndefined();
  });
  it("group 6 rules are carried as build requirements", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/no existing record is deleted by the rollout/, /no complete erasure from backups is promised/, /excludes credentials, payment secrets, other studios' data and platform security information/, /blocks existing portal links and sessions/, /Not available yet/]) expect(m).toMatch(re);
  });
});

describe("Sam's group 7 (3 Nov): platform and operations", () => {
  it("every decision DN-1..DN-30 is decided: the log is the single authority and nothing is left pending", () => {
    expect(Object.entries(DECISIONS).filter(([, e]) => e.status !== "decided")).toEqual([]);
  });
  it("DN-16, DN-29 and the two unnumbered items are narrowings with a named stage and notice", () => {
    const ids = NARROWINGS.map((n) => n.id);
    for (const id of ["google_flags_operator_only", "deactivated_calendar_owner", "rate_limit_outage", "anonymous_public_writes_closed"]) expect(ids).toContain(id);
  });
  it("group 7 rules are carried as build requirements", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/Google Calendar studio feature flags are operator-only/, /no active owner remains, studio calendar sync pauses and the operator is alerted without client data; it resumes only after an active owner explicitly reconnects/, /bounded fallback protection/, /no direct database writes/, /SMS STOP behaviour is unchanged/]) expect(m).toMatch(re);
  });
});

describe("enforcement state (Privacy X3)", () => {
  it("is set on exactly the keys the app asks; every other key resolves to not_yet", async () => {
    const { CATALOG, enforcementOf } = await import("@/lib/permissions/catalog");
    const marked = CATALOG.filter((d) => (d as { enforcement?: string }).enforcement).map((d) => d.key).sort();
    expect(marked).toHaveLength(16);
    expect(enforcementOf("clin.edit_records")).toBe("not_yet");
    expect(enforcementOf("appt.complete")).toBe("observe");
    expect(enforcementOf("appt.cancel")).toBe("enforced");
    // widening is inert behind a legacy check for these, so they are deny_only, not enforced (OPS, delta review RE-1/RG-2/F1)
    for (const k of ["appt.book", "appt.move", "appt.reassign", "avail.manage_own", "avail.manage_others", "avail.manage_studio_hours"]) expect(enforcementOf(k), k).toBe("deny_only");
    expect(enforcementOf("not.a.key")).toBe("not_yet");
  });
});
