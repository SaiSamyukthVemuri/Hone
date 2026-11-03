import { describe, expect, it } from "vitest";
import { CATALOG, FIXED_OWNER_ONLY, MANDATORY, catalogByKey, ROLES, type PermissionDef } from "@/lib/permissions/catalog";
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

describe("decisions: DN-1..DN-30 are all accounted for, and a pending key never drifts from today's behaviour", () => {
  it("has exactly DN-1..DN-30", () => {
    expect(Object.keys(DECISIONS).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))).toEqual(Array.from({ length: 30 }, (_, i) => `DN-${i + 1}`));
  });
  it("a key marked pendingDecision ships with the existing-studio snapshot as its value for EVERY studio", () => {
    const pinned = DEFS.filter((d) => d.pendingDecision?.length);
    expect(pinned.length).toBeGreaterThan(0);
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
