import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG,
  FIXED_OWNER_ONLY,
  GROUPS,
  MANDATORY,
  NOT_OFFERED_AS_TOGGLES,
  ROLES,
  SCOPES,
  catalogByKey,
  checkChange,
  defaultsFor,
  effectiveScope,
  renderCatalogMarkdown,
  scopeRank,
  type PermissionDef,
  type Scope,
} from "@/lib/permissions/catalog";

// R0 validity of the ONE permission catalog. Pure data: nothing imports it yet, so none of this changes behaviour.
const DEFS = CATALOG as readonly PermissionDef[];
const DOC = readFileSync(path.resolve(__dirname, "../../../docs/security/permissions-catalog.md"), "utf8");

describe("catalog shape", () => {
  it("has unique keys, each in exactly one of Sam's eight groups, and every group is used", () => {
    expect(new Set(DEFS.map((d) => d.key)).size).toBe(DEFS.length);
    for (const d of DEFS) expect(GROUPS).toContain(d.group);
    for (const g of GROUPS) expect(DEFS.some((d) => d.group === g)).toBe(true);
    expect(GROUPS).toEqual(["appointments", "clients_identity", "clinical_records", "communications", "payments", "pricing", "availability", "reports"]);
  });

  it("keys follow group.name and scopes are valid, start with off, and 'own' is explained exactly when offered", () => {
    for (const d of DEFS) {
      expect(d.key).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(d.scopes[0]).toBe("off");
      for (const s of d.scopes) expect(SCOPES).toContain(s);
      expect(d.scopes.includes("own")).toBe(typeof d.own === "string" && d.own.length > 0);
    }
  });

  it("every default and snapshot value is a scope the key allows, for both roles", () => {
    for (const d of DEFS) {
      for (const r of ROLES) {
        expect(d.scopes, `${d.key} default ${r}`).toContain(d.newStudioDefault[r]);
        expect(d.scopes, `${d.key} snapshot ${r}`).toContain(d.existingSnapshot[r]);
      }
    }
  });

  it("a key not offered to a role is OFF in every default and snapshot for that role", () => {
    for (const d of DEFS) for (const r of ROLES) if (!d.offeredTo[r]) {
      expect(d.newStudioDefault[r], `${d.key} ${r}`).toBe("off");
      expect(d.existingSnapshot[r], `${d.key} ${r}`).toBe("off");
    }
  });

  it("a fixed baseline (not owner-configurable) is only the calendar view", () => {
    expect(DEFS.filter((d) => !d.ownerConfigurable).map((d) => d.key)).toEqual(["appt.view_calendar"]);
  });
});

describe("prerequisites", () => {
  it("every prerequisite names a catalog key and the graph is acyclic", () => {
    for (const d of DEFS) for (const r of d.requires) expect(catalogByKey.has(r), `${d.key} requires ${r}`).toBe(true);
    const state = new Map<string, 1 | 2>();
    const visit = (k: string, trail: string[]) => {
      if (state.get(k) === 2) return;
      expect(state.get(k), `cycle: ${[...trail, k].join(" -> ")}`).not.toBe(1);
      state.set(k, 1);
      for (const r of catalogByKey.get(k)!.requires) visit(r, [...trail, k]);
      state.set(k, 2);
    };
    for (const d of DEFS) visit(d.key, []);
  });

  it("no default or snapshot value exceeds what its prerequisites allow (a ship-state never relies on an auto-enabled key)", () => {
    for (const basis of ["newStudio", "existingSnapshot"] as const) {
      for (const r of ROLES) {
        const values = defaultsFor(r, basis);
        for (const d of DEFS) {
          if (!d.offeredTo[r]) continue;
          expect(effectiveScope(r, d.key, values), `${basis} ${r} ${d.key}`).toBe(values[d.key]);
        }
      }
    }
  });

  it("every payment, pricing-per-appointment and report key requires seeing the payment, and the report keys need it at Whole studio", () => {
    for (const d of DEFS.filter((x) => x.group === "payments" && x.key !== "pay.view_appointment")) expect(d.requires).toContain("pay.view_appointment");
    expect(catalogByKey.get("price.appointment")!.requires).toContain("pay.view_appointment");
    for (const k of ["rep.studio_totals", "rep.financial_reports", "rep.lifetime_spend"]) expect(catalogByKey.get(k)!.requires).toContain("pay.view_appointment");
    const owner = defaultsFor("practitioner", "newStudio"); // pay.view_appointment = own
    expect(checkChange("practitioner", "rep.studio_totals", "studio", owner).ok).toBe(false);
    expect(checkChange("practitioner", "rep.studio_totals", "studio", { ...owner, "pay.view_appointment": "studio" }).ok).toBe(true);
  });
});

describe("Sam's spec, encoded", () => {
  const d = (k: string) => catalogByKey.get(k)!;

  it("C.3: every finance key defaults ON for both staff roles in a new studio, as SEPARATE keys", () => {
    const keys = ["pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.service_list", "price.fee_amounts"];
    expect(new Set(keys).size).toBe(8);
    for (const k of keys) { expect(d(k).newStudioDefault.practitioner).not.toBe("off"); expect(d(k).newStudioDefault.receptionist).not.toBe("off"); }
  });

  it("C.3: practitioners default to own assigned appointments, receptionists to the studio", () => {
    for (const k of ["pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment"]) {
      expect(d(k).newStudioDefault.practitioner).toBe("own");
      expect(d(k).newStudioDefault.receptionist).toBe("studio");
    }
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
    for (const x of DEFS.filter((y) => ["payments", "pricing"].includes(y.group) || ["rep.studio_totals", "rep.financial_reports", "rep.lifetime_spend"].includes(y.key))) expect(x.killSwitch, x.key).toBe(true);
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
    for (const k of ["clin.view_records", "clin.edit_records", "clin.view_photos", "clin.view_intake", "appt.complete", "appt.aftercare_send", "client.view_legal_name", "client.edit_legal_name"]) expect(r(k)).toBe("off");
    // enabling one must not grant the others: view and edit are different keys, and the edit key REQUIRES the view key rather than implying it
    expect(d("client.edit_legal_name").requires).toEqual(["client.view_legal_name"]);
    expect(d("clin.edit_records").requires).toEqual(["clin.view_records"]);
    const v = defaultsFor("receptionist", "newStudio");
    expect(checkChange("receptionist", "client.edit_legal_name", "studio", v).ok).toBe(false); // refused, NOT silently enabling the view key
    expect(effectiveScope("receptionist", "client.view_legal_name", v)).toBe("off");
  });

  it("C.4: routine communications are ON within scope and both bulk and audit-log access are OFF for both roles", () => {
    for (const r of ROLES) { expect(d("comm.send_routine").newStudioDefault[r]).not.toBe("off"); expect(d("comm.bulk_message").newStudioDefault[r]).toBe("off"); expect(d("rep.audit_log_view").newStudioDefault[r]).toBe("off"); }
  });

  it("C.5: the fixed owner-only items have NO key and no default", () => {
    const text = FIXED_OWNER_ONLY.map((f) => f.id).join(" ");
    for (const must of ["manage_roles_permissions_ownership", "provider_credentials_bank_payouts", "studio_account_deletion", "permanent_deletion_bulk_destructive", "audit_history_delete_alter", "delete_treatment_records_and_photos", "archive_clients", "restore_deleted_records"]) expect(text).toContain(must);
    for (const f of FIXED_OWNER_ONLY) expect(catalogByKey.has(f.id), f.id).toBe(false);
    for (const x of DEFS) expect(x.key).not.toMatch(/(roles?|ownership|credential|payout|bank|delete|archive|restore|destroy)/);
  });

  it("C.5: the fixed items that NARROW existing practitioners are flagged, so adoption carries a notice", () => {
    expect(FIXED_OWNER_ONLY.filter((f) => f.existingEffect === "narrows").map((f) => f.id).sort()).toEqual(["archive_clients", "delete_treatment_records_and_photos", "restore_deleted_records"]);
  });

  it("C.6: the existing-studio snapshot never exceeds the new-studio default (adopting can only widen, never narrow, through keys)", () => {
    for (const x of DEFS) for (const r of ROLES) expect(scopeRank(x.existingSnapshot[r]), `${x.key} ${r}`).toBeLessThanOrEqual(scopeRank(x.newStudioDefault[r]));
  });

  it("C.6: no existing-studio snapshot grants any finance, pricing or money-report access", () => {
    for (const x of DEFS.filter((y) => ["payments", "pricing"].includes(y.group) || y.key.startsWith("rep."))) for (const r of ROLES) expect(x.existingSnapshot[r], `${x.key} ${r}`).toBe("off");
  });

  it("the database holes are OFF in the snapshot and say so (H1, H2, M-2, M-3, M-4)", () => {
    for (const k of ["price.service_list", "clin.edit_consent_templates", "pay.view_appointment", "rep.lifetime_spend"]) expect(d(k).snapshotBasis).toBe("approved_policy");
  });

  it("gated keys carry their ship gate: receptionist finance waits for removal and R-1; completion waits for #1315/0277", () => {
    for (const k of ["pay.view_appointment", "pay.record_external", "pay.charge_saved_card", "pay.refund", "pay.void", "pay.correct_or_waive", "price.appointment", "price.service_list", "price.fee_amounts"]) expect(d(k).shipGate?.receptionist, k).toMatch(/R-1/);
    expect(d("appt.complete").shipGate?.practitioner).toMatch(/1315/);
  });

  it("mandatory and not-offered lists are present and name the key rules", () => {
    expect(MANDATORY.join(" ")).toMatch(/isolation/);
    expect(MANDATORY.join(" ")).toMatch(/remaining refundable/);
    expect(MANDATORY.join(" ")).toMatch(/at least one active owner/);
    expect(NOT_OFFERED_AS_TOGGLES.length).toBeGreaterThan(0);
  });
});

describe("prerequisite behaviour (the page, server and database must all do exactly this)", () => {
  const base = () => ({ ...defaultsFor("practitioner", "newStudio") });

  it("turning a prerequisite OFF makes dependents effectively OFF but keeps their stored value", () => {
    const v: Record<string, Scope> = { ...base(), "pay.view_appointment": "off" };
    expect(effectiveScope("practitioner", "pay.refund", v)).toBe("off");
    expect(v["pay.refund"]).toBe("own"); // stored value untouched
    expect(effectiveScope("practitioner", "pay.refund", { ...v, "pay.view_appointment": "own" })).toBe("own"); // restored, not re-guessed
  });

  it("a dependent is capped by its prerequisite's scope", () => {
    const v: Record<string, Scope> = { ...base(), "pay.refund": "studio", "pay.view_appointment": "own" };
    expect(effectiveScope("practitioner", "pay.refund", v)).toBe("own");
  });

  it("setting a dependent above its prerequisite is REFUSED with the prerequisite named, and nothing else is changed", () => {
    const v: Record<string, Scope> = { ...base(), "pay.view_appointment": "off" };
    const res = checkChange("practitioner", "pay.refund", "own", v);
    expect(res).toMatchObject({ ok: false, blockedBy: "pay.view_appointment" });
    if (!res.ok) expect(res.reason).toMatch(/first/);
    expect(v["pay.view_appointment"]).toBe("off"); // never silently enabled
  });

  it("lowering a prerequisite is always allowed; scopes and unknown or unoffered keys are refused", () => {
    expect(checkChange("practitioner", "pay.view_appointment", "off", base()).ok).toBe(true);
    expect(checkChange("practitioner", "pay.refund", "bogus" as never, base()).ok).toBe(false);
    expect(checkChange("practitioner", "no.such_key", "studio", base()).ok).toBe(false);
    expect(checkChange("receptionist", "avail.manage_own", "studio", defaultsFor("receptionist", "newStudio")).ok).toBe(false);
    expect(checkChange("practitioner", "appt.view_calendar", "off", base()).ok).toBe(false);
    expect(checkChange("practitioner", "price.service_list", "own" as never, base()).ok).toBe(false);
  });

  it("an unknown key or a not-offered key is effectively OFF (fails closed)", () => {
    expect(effectiveScope("practitioner", "no.such_key", base())).toBe("off");
    expect(effectiveScope("receptionist", "avail.manage_own", { "avail.manage_own": "studio" })).toBe("off");
  });
});

describe("the doc embeds the generated table", () => {
  it("docs/security/permissions-catalog.md contains exactly the generated catalog block", () => {
    const m = DOC.match(/<!-- catalog:begin -->\n([\s\S]*?)\n<!-- catalog:end -->/);
    expect(m, "catalog markers missing").not.toBeNull();
    expect(m![1]).toBe(renderCatalogMarkdown());
  });
});
