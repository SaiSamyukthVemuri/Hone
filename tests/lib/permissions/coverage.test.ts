import { describe, expect, it } from "vitest";
import { ASSIGNED_CLIENT, CATALOG, FIXED_OWNER_ONLY, MANDATORY, NARROWINGS, OPERATOR_CONFIG, catalogByKey, scopesFor, ROLES, type PermissionDef } from "@/lib/permissions/catalog";
import { COVERAGE, COVERAGE_ROW_COUNT } from "@/lib/permissions/coverage";
import { DECISIONS, OPEN_QUESTIONS } from "@/lib/permissions/decisions";

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
  it("every catalog key is reachable from an audit row, except the capabilities the product does not have yet (no audit row exists for them)", () => {
    const reached = new Set(Object.values(COVERAGE).flatMap((r) => r.keys));
    const unreached = DEFS.map((d) => d.key).filter((k) => !reached.has(k)).sort();
    expect(unreached).toEqual(["appt.handoff_own", "client.merge", "comm.bulk_message", "rep.bulk_export"]);
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
    for (const g of ["dob_address", "allergies_cautions", "budget", "personal_notes", "tags", "health_fields"]) {
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
  it("catalog flags cite only known decisions (DN) that are still pending, or known OPEN questions (Q); a decided DN leaves no flag behind", () => {
    for (const d of DEFS) {
      for (const id of [...(d.pendingDecision ?? []), ...(d.touchedByDecision ?? [])]) {
        if (id.startsWith("Q-") || id.startsWith("B-")) expect(OPEN_QUESTIONS[id as keyof typeof OPEN_QUESTIONS], `${d.key} cites unknown ${id}`).toBeDefined();
        else {
          expect(DECISIONS[id as keyof typeof DECISIONS], `${d.key} cites unknown ${id}`).toBeDefined();
          expect(DECISIONS[id as keyof typeof DECISIONS].status, `${d.key} still flagged by decided ${id}`).toBe("pending");
        }
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
    expect(ops.map((d) => d.key).sort()).toEqual(["wl.add_entry", "wl.expire_close", "wl.import_entry", "wl.manage_queue", "wl.offer_booking", "wl.record_sms_consent", "wl.set_availability", "wl.view_queue", "wl.withdraw_entry"]);
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
      expect(d.pendingDecision ?? [], d.key).not.toEqual(expect.arrayContaining([expect.stringMatching(/^DN-/)]));
    }
    expect(catalogByKey.get("avail.manage_studio_hours")!.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
    expect(catalogByKey.get("avail.manage_others")!.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
  });
});

describe("open questions (OPS reconciliation, 3 Nov): flagged, never defaulted", () => {
  const NARROW = new Set(NARROWINGS.map((n) => n.id));
  const FIXED = new Set(FIXED_OWNER_ONLY.map((f) => f.id));
  it("OPS's Q1 to Q25 (plus the Q14b follow-up) and Team's three B-n items are registered; after batch 4 every Q and every Team-raised B-n item is settled", () => {
    const keys = Object.keys(OPEN_QUESTIONS);
    const q = keys.filter((k) => k.startsWith("Q-")).map((k) => Number.parseInt(k.slice(2), 10));
    for (let n = 1; n <= 25; n += 1) if (n !== 5 && n !== 11) expect(q, `Q-${n}`).toContain(n);
    expect(keys.filter((k) => k.startsWith("B-")).sort()).toEqual(["B-1", "B-2", "B-3"]);
    expect(Object.entries(OPEN_QUESTIONS).filter(([, e]) => e.status === "settled").map(([k]) => k).sort())
      .toEqual([...keys].sort());
    expect(keys).toContain("Q-14b");
  });
  it("every open question names a surface that exists: a key, FEE_AMOUNT_READ, a narrowing or a fixed owner-only item", () => {
    for (const [q, e] of Object.entries(OPEN_QUESTIONS)) {
      expect(e.surface.length, q).toBeGreaterThan(0);
      for (const sf of e.surface) expect(catalogByKey.has(sf) || sf === "FEE_AMOUNT_READ" || NARROW.has(sf) || FIXED.has(sf), `${q} -> ${sf}`).toBe(true);
    }
  });
  it("every OPEN question that names a key is flagged on that key; a settled question is flagged on none", () => {
    for (const [q, e] of Object.entries(OPEN_QUESTIONS)) {
      if (e.status === "settled") {
        for (const d of DEFS) expect([...(d.pendingDecision ?? []), ...(d.touchedByDecision ?? [])], `${d.key} still flagged by settled ${q}`).not.toContain(q);
        continue;
      }
      for (const sf of e.surface) {
        const def = catalogByKey.get(sf);
        if (def) expect([...(def.pendingDecision ?? []), ...(def.touchedByDecision ?? [])], `${sf} should carry ${q}`).toContain(q);
      }
    }
  });
  it("settled by OPS (3 Nov): receptionist routine messaging is ON for a new studio, existing studios keep today's access", () => {
    const k = catalogByKey.get("comm.send_routine")!;
    expect(k.newStudioDefault).toEqual({ practitioner: "studio", receptionist: "studio" });
    expect(k.existingSnapshot).toEqual({ practitioner: "studio", receptionist: "off" });
    expect(k.pendingDecision).toBeUndefined();
  });
  it("settled: own availability is Off for existing studios and ON for a new one; Google flags are operator-only, not owner-only; no 72-hour window is stated", () => {
    const k = catalogByKey.get("avail.manage_own")!;
    expect(k.existingSnapshot.practitioner).toBe("off");
    expect(k.newStudioDefault.practitioner).toBe("studio");
    expect(COVERAGE["GC-11"]!.cls).toBe("operator_only");
    expect(COVERAGE["SCH-12"]!.label).not.toMatch(/72/);
    expect(JSON.stringify(FIXED_OWNER_ONLY.find((f) => f.id === "revert_recorded_outcome"))).not.toMatch(/72/);
  });
});

describe("Sam's batch 1 (3 Nov): Q1, Q3, Q4, Q6, Q7", () => {
  it("Q4 / DN-5: pronouns ride with contact identity, skin and goals with the clinical record, and no budget or personal-notes key is bundled", () => {
    expect(COVERAGE["CLI-16"]!.keys).toEqual(["clin.edit_records"]);
    expect(COVERAGE["SCH-2"]!.keys).toEqual(expect.arrayContaining(["client.view_directory", "clin.view_records"]));
    expect(catalogByKey.has("client.view_budget_goals")).toBe(false);
    for (const k of ["client.view_budget", "client.view_personal_notes", "client.view_tags"]) expect(catalogByKey.get(k)!.requires).not.toContain("client.view_allergies_cautions");
  });
  it("Q6 / DN-14: portal replies are offered at whole-studio and assigned-client scope, with the definition on the own scope", () => {
    const k = catalogByKey.get("comm.send_portal_reply")!;
    expect(scopesFor(k, "practitioner")).toEqual(["off", "own", "studio"]);
    expect(scopesFor(k, "receptionist")).toEqual(["off", "studio"]);
    expect(k.own).toBe(ASSIGNED_CLIENT);
    expect(ASSIGNED_CLIENT).toMatch(/at least one appointment/);
    expect(ASSIGNED_CLIENT).toMatch(/CURRENTLY assigned/);
    expect(ASSIGNED_CLIENT).toMatch(/no clinical access/);
    expect(ASSIGNED_CLIENT).toMatch(/last such appointment/);
    expect(ASSIGNED_CLIENT).toMatch(/unless you hold a studio-wide permission/);
    expect(catalogByKey.get("price.view_client_prices")!.own).toBe(ASSIGNED_CLIENT);
    expect(k.existingSnapshot).toEqual({ practitioner: "studio", receptionist: "off" });
    expect(k.pendingDecision).toBeUndefined();
  });
  it("Q7 / DN-11: setting a client price is Off or On (whole studio) only, OFF for both roles, with no pending flag", () => {
    const k = catalogByKey.get("price.edit_client_prices")!;
    expect(scopesFor(k, "practitioner")).toEqual(["off", "studio"]);
    expect(k.newStudioDefault).toEqual({ practitioner: "off", receptionist: "off" });
    expect(k.pendingDecision).toBeUndefined();
    expect(MANDATORY.join("\n")).toMatch(/grants no other pricing or payment permission/);
  });
  it("Q1 / DN-23b: the late-cancel window is an owner policy in whole hours 1-168, unset by default, and not a staff key", () => {
    const m = MANDATORY.join("\n");
    expect(m).toMatch(/whole number of hours from 1 to 168, UNSET by default/);
    expect(m).toMatch(/unset means late-cancellation charging is unavailable/);
    expect(FIXED_OWNER_ONLY.map((f) => f.id)).toContain("late_cancel_window");
    expect(DEFS.some((x) => /late_cancel/.test(x.key))).toBe(false);
  });
  it("Q3 and Q21: the limiter fallback and anonymous limits are OPERATOR configuration, not catalog keys, with the stated numbers", () => {
    const byId = Object.fromEntries(OPERATOR_CONFIG.map((o) => [o.id, o]));
    expect(byId.limiter_fallback_visitor!.value).toMatch(/5 attempts per 10 minutes/);
    expect(byId.limiter_fallback_studio!.value).toMatch(/30 attempts per hour/);
    expect(byId.anonymous_visitor_limit!.value).toMatch(/5 attempts per hour/);
    expect(byId.anonymous_email_limit!.value).toMatch(/3 attempts per day/);
    for (const o of OPERATOR_CONFIG) expect(catalogByKey.has(o.id), o.id).toBe(false);
    expect(MANDATORY.join("\n")).toMatch(/if the shared fallback cannot enforce a bound, submissions are refused safely/);
  });
});
