import { describe, expect, it } from "vitest";
import { CATALOG, FIXED_OWNER_ONLY, MANDATORY, NARROWINGS, catalogByKey, ROLES, type PermissionDef } from "@/lib/permissions/catalog";
import { COVERAGE, COVERAGE_ROW_COUNT } from "@/lib/permissions/coverage";
import { DECISIONS } from "@/lib/permissions/decisions";

const DEFS = CATALOG as readonly PermissionDef[];

describe("coverage map: every audit row is covered by a key or a fixed rule", () => {
  it("maps all 258 rows of the current-access matrix, once each", () => {
    expect(Object.keys(COVERAGE)).toHaveLength(COVERAGE_ROW_COUNT);
    expect(COVERAGE_ROW_COUNT).toBe(258);
  });
  it("a row classed 'key' names at least one key; every named key exists; other classes name none unless they cite a key for context", () => {
    for (const [id, row] of Object.entries(COVERAGE)) {
      if (row.cls === "key") expect(row.keys.length, id).toBeGreaterThan(0);
      for (const k of row.keys) expect(catalogByKey.has(k), `${id} -> ${k}`).toBe(true);
    }
  });
  it("every catalog key is reachable from an audit row, except the four capabilities the product does not have yet", () => {
    const reached = new Set(Object.values(COVERAGE).flatMap((r) => r.keys));
    const unreached = DEFS.map((d) => d.key).filter((k) => !reached.has(k)).sort();
    expect(unreached).toEqual(["client.merge", "comm.bulk_message", "rep.bulk_export"]);
  });
  it("Sam's group 1 and 2 rows resolve to the decided keys", () => {
    expect(COVERAGE["WL-1"]!.keys).toEqual(["wl.view_queue"]);
    expect(COVERAGE["WL-5"]!.keys).toEqual(["wlrules.invitation_rounds"]);
    expect(COVERAGE["WL-8"]!.keys).toEqual(["wl.import_entry"]);
    expect(COVERAGE["SET-8"]!.keys).toEqual(["admit.change_policy"]);
    expect(COVERAGE["AV-1"]!.keys).toEqual(["avail.manage_studio_hours"]);
  });
  it("Sam's group 3 rows resolve to the decided keys and rules", () => {
    expect(COVERAGE["CLI-3"]!.keys).toEqual(["client.view_dob_address"]);
    expect(COVERAGE["CLI-19"]!.keys).toEqual(["client.edit_allergies_cautions"]);
    expect(COVERAGE["CLIN-13"]!.keys).toEqual(["clin.edit_records"]);
    expect(COVERAGE["CLIN-14"]!.keys).toEqual(["clin.edit_records"]);
    expect(COVERAGE["REC-1"]!.keys).toEqual(["records.view_sterilisation_disinfection"]);
    expect(COVERAGE["REC-2"]!.keys).toEqual(["records.log_sterilisation_disinfection"]);
    expect(COVERAGE["SCH-12"]!.cls).toBe("fixed_owner");
    expect(COVERAGE["PHO-5"]!.cls).toBe("fixed_owner");
    expect(COVERAGE["CLIN-15"]!.cls).toBe("safeguard");
    expect(COVERAGE["REC-5"]!.cls).toBe("safeguard");
  });
  it("DN-5: receptionists are OFF by default, view keys are offered read-only, edit keys are not offered", () => {
    for (const g of ["dob_address", "allergies_cautions", "budget_goals", "personal_notes", "tags", "health_fields"]) {
      const v = DEFS.find((d) => d.key === `client.view_${g}`)!;
      const e = DEFS.find((d) => d.key === `client.edit_${g}`)!;
      expect(v.newStudioDefault).toEqual({ practitioner: "studio", receptionist: "off" });
      expect(v.offeredTo.receptionist).toBe(true);
      expect(e.offeredTo.receptionist).toBe(false);
      expect(e.requires).toContain(v.key);
    }
  });
  it("DN-7, DN-12, DN-24: no staff key exists for outcome revert or ID portraits; whole-session delete no longer lists area or block removal", () => {
    expect(DEFS.some((d) => d.key === "appt.revert_outcome" || d.key === "clin.view_id_portrait")).toBe(false);
    const del = FIXED_OWNER_ONLY.find((f) => f.id === "delete_treatment_records_and_photos");
    expect(del?.enforcedBy).not.toContain("public.soft_delete_session_area");
    expect(del?.enforcedBy).not.toContain("public.soft_delete_session_block");
    expect(FIXED_OWNER_ONLY.map((f) => f.id)).toEqual(expect.arrayContaining(["revert_recorded_outcome", "id_photos_portraits"]));
  });
  it("fixed-owner rows do not name a staff key", () => {
    for (const [id, row] of Object.entries(COVERAGE)) if (row.cls === "fixed_owner") expect(row.keys, id).toEqual([]);
    expect(FIXED_OWNER_ONLY.length).toBeGreaterThan(0);
  });
});

describe("coverage map agrees with the matrix and with the catalog (Insurance R-1, R-2; Codex)", () => {
  it("a row's keys cover every key the matrix recommends for it, unless the row states the decided reason it departs", () => {
    for (const [id, row] of Object.entries(COVERAGE)) {
      const missing = (row.matrix ?? []).filter((k) => !row.keys.includes(k));
      if (missing.length) expect(row.departs?.length ?? 0, `${id} drops ${missing.join(", ")} without a reason`).toBeGreaterThan(20);
      else expect(row.departs, `${id} states a departure it does not need`).toBeUndefined();
    }
  });
  it("R-1: staff intake requests and portal messages are keyed, not owner-only, so a follow-on PR does not silently narrow practitioners", () => {
    for (const id of ["INT-3", "PORT-1", "PORT-8"]) expect(COVERAGE[id]!.cls, id).toBe("key");
    expect(COVERAGE["INT-3"]!.keys).toEqual(["comm.send_intake_link", "clin.view_intake_status"]);
    expect(COVERAGE["PORT-8"]!.keys).toEqual(["comm.send_portal_reply"]);
  });
  it("R-2: decided rules classed as a rule name where they are enforced, and are not owner-only or base", () => {
    for (const id of ["NAV-9", "ST-9", "ST-8", "GC-2", "COM-10", "CLIN-15", "REC-4", "REC-5", "PORT-4", "SET-9"]) {
      expect(COVERAGE[id]!.enforcement?.length ?? 0, id).toBeGreaterThan(20);
      expect(["owner_only", "base"], id).not.toContain(COVERAGE[id]!.cls);
    }
    expect(COVERAGE["SET-9"]!.keys).toEqual(expect.arrayContaining(["price.fee_amounts", "pay.view_appointment"]));
  });
  it("group 5: the late-cancel fee row names the server rule and held migration 0293; card-authorisation reads stay read-only via the pay view", () => {
    expect(COVERAGE["PAY-5"]!.enforcement).toMatch(/0293/);
    expect(COVERAGE["PAY-5"]!.enforcement).toMatch(/policy snapshot/);
    expect(COVERAGE["INT-10"]!.enforcement).toMatch(/read-only/);
    expect(COVERAGE["PAY-20"]!.cls).toBe("fixed_owner");
  });
  it("Codex: a mixed photo row that also archives points at the fixed owner-only rule, which exists", () => {
    expect(COVERAGE["PHO-3"]!.fixed).toEqual(["delete_treatment_records_and_photos"]);
    for (const row of Object.values(COVERAGE)) for (const f of row.fixed ?? []) expect(FIXED_OWNER_ONLY.map((x) => x.id)).toContain(f);
  });
  it("every enforcement text that cites a narrowing cites one that exists", () => {
    const ids = new Set(NARROWINGS.map((n) => n.id));
    for (const [id, row] of Object.entries(COVERAGE)) for (const m of row.enforcement?.matchAll(/NARROWINGS (\w+)/g) ?? []) expect(ids.has(m[1]!), `${id} cites ${m[1]}`).toBe(true);
  });
});

describe("decisions: DN-1..DN-30 are all accounted for, and a pending key never drifts from today's behaviour", () => {
  it("has exactly DN-1..DN-30", () => {
    expect(Object.keys(DECISIONS).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))).toEqual(Array.from({ length: 30 }, (_, i) => `DN-${i + 1}`));
  });
  it("a key marked pendingDecision ships with the existing-studio snapshot as its value for EVERY studio", () => {
    const pinned = DEFS.filter((d) => d.pendingDecision?.length);
    // After Sam's group 6 no key is pending; the invariant stays so any key flagged later is pinned to today's value.
    for (const d of pinned) for (const r of ROLES) expect(d.newStudioDefault[r], `${d.key}:${r}`).toBe(d.existingSnapshot[r]);
  });
  it("catalog flags only cite known, still-pending decisions; a decided decision leaves no flag behind", () => {
    for (const d of DEFS) {
      for (const id of [...(d.pendingDecision ?? []), ...(d.touchedByDecision ?? [])]) {
        expect(DECISIONS[id], `${d.key} cites unknown ${id}`).toBeDefined();
        expect(DECISIONS[id].status, `${d.key} still flagged by decided ${id}`).toBe("pending");
      }
    }
  });
  it("every pending decision that the registry says has a key is flagged on at least one key", () => {
    const flagged = new Set(DEFS.flatMap((d) => [...(d.pendingDecision ?? []), ...(d.touchedByDecision ?? [])]));
    for (const [id, e] of Object.entries(DECISIONS)) if (e.status === "pending" && e.keyed) expect(flagged.has(id as never), id).toBe(true);
  });
  it("group 1 and 2 decisions are carried as build requirements", () => {
    const m = MANDATORY.join("\n");
    for (const re of [/never see the Business tab/, /display names and calendar colours only/, /feed tokens and their hashes are secrets/, /fee amounts need the relevant payment or pricing permission/, /only the tasks the viewer has permission to perform/, /importing a waitlist entry never records consent/, /never completes an appointment automatically/, /actual Open \/ Waitlist \/ Closed setting/]) expect(m).toMatch(re);
  });
  it("waitlist operations are separate per-action keys: receptionist ON but gated, practitioner OFF; rules OFF for both; admission OFF for both", () => {
    const ops = DEFS.filter((d) => d.group === "waitlist_operations");
    expect(ops.map((d) => d.key).sort()).toEqual(["wl.add_entry", "wl.import_entry", "wl.manage_queue", "wl.offer_booking", "wl.record_sms_consent", "wl.set_availability", "wl.view_queue", "wl.withdraw_entry"]);
    for (const d of ops) {
      expect(d.newStudioDefault).toEqual({ practitioner: "off", receptionist: "studio" });
      expect(d.existingSnapshot).toEqual({ practitioner: "off", receptionist: "off" });
      expect(d.shipGate?.receptionist).toBe("receptionist_waitlist");
      expect(d.offeredTo).toEqual({ practitioner: true, receptionist: true });
      if (d.key !== "wl.view_queue") expect(d.requires).toContain("wl.view_queue");
    }
    for (const d of DEFS.filter((x) => x.group === "waitlist_rules" || x.group === "accepting_new_clients")) {
      expect(d.newStudioDefault, d.key).toEqual({ practitioner: "off", receptionist: "off" });
      expect(d.offeredTo, d.key).toEqual({ practitioner: true, receptionist: true });
      expect(d.pendingDecision, d.key).toBeUndefined();
    }
    expect(catalogByKey.get("avail.manage_studio_hours")!.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
    expect(catalogByKey.get("avail.manage_others")!.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
  });
});
