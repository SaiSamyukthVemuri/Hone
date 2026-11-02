import { describe, expect, it } from "vitest";
import {
  adoptCurrent,
  baselineFromRow,
  CLEAR_PREFERRED_ERROR,
  describeConflicts,
  parseBaseline,
  planProfileUpdate,
  type ProfileBaseline,
} from "@/lib/clients/profile-baseline";

// Identity readiness (Privacy R1/R2, Insurance C-3/C-4/C-5): the profile save writes only what the staff member
// changed, and only while the stored value is still what their page loaded. Synthetic values only.

const LOADED: ProfileBaseline = {
  name: "Dana Reyes", preferred_name: "Dee", pronouns: "she/her", date_of_birth: "1990-01-02", phone: "604-555-0100",
  email: "dana@example.test", address: "1 Test St", fitzpatrick_type: 3, allergies: "none", emergency_contact_name: "Sam",
  emergency_contact_phone: "604-555-0111",
};
const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("baseline wire format", () => {
  it("round-trips the loaded row and refuses anything that is not a complete baseline", () => {
    expect(parseBaseline(JSON.stringify(baselineFromRow({ ...LOADED, skin_notes: "legacy", id: "x" })))).toEqual(LOADED);
    for (const bad of [undefined, null, "", "not json", "[]", "null", JSON.stringify({ name: "x" }),
      JSON.stringify({ ...LOADED, phone: { a: 1 } }), JSON.stringify({ ...LOADED, name: true })]) {
      expect(parseBaseline(bad)).toBeNull();
    }
  });
});

describe("planProfileUpdate writes only submitted, changed fields", () => {
  it("an omitted field is never a candidate: nothing is written for it", () => {
    const plan = planProfileUpdate(fd({ pronouns: "they/them" }), LOADED);
    expect(plan).toEqual({ ok: true, patch: { pronouns: "they/them" }, conditions: [{ key: "pronouns", value: "she/her" }] });
  });

  it("a submission equal to the loaded values changes nothing", () => {
    const same = fd({ name: "Dana Reyes", preferred_name: "Dee", phone: "604-555-0100", fitzpatrick_type: "3", email: " dana@example.test " });
    expect(planProfileUpdate(same, LOADED)).toEqual({ ok: true, patch: {}, conditions: [] });
  });

  it("a stale tab cannot blank a value that a newer edit set: its blank is a change against ITS baseline only", () => {
    // The tab loaded phone = null; someone else then stored a phone. This tab submits phone "" (unchanged for it).
    const stale: ProfileBaseline = { ...LOADED, phone: null };
    expect(planProfileUpdate(fd({ phone: "", address: "2 New Rd" }), stale)).toEqual({
      ok: true, patch: { address: "2 New Rd" }, conditions: [{ key: "address", value: "1 Test St" }],
    });
  });

  it("each changed column carries the value it must still hold", () => {
    const plan = planProfileUpdate(fd({ phone: "778-555-0123", fitzpatrick_type: "4", allergies: "" }), LOADED);
    expect(plan).toMatchObject({ ok: true, patch: { phone: "778-555-0123", fitzpatrick_type: 4, allergies: null } });
    if (plan.ok) {
      expect(plan.conditions).toEqual([
        { key: "phone", value: "604-555-0100" }, { key: "fitzpatrick_type", value: 3 }, { key: "allergies", value: "none" },
        // phone is an identity field: the other two identity fields are guarded for the duplicate check
        { key: "name", value: "Dana Reyes", guard: true }, { key: "date_of_birth", value: "1990-01-02", guard: true },
      ]);
    }
  });

  it("name is required when submitted, and a too-long preferred name is refused, never cut", () => {
    expect(planProfileUpdate(fd({ name: "   " }), LOADED)).toEqual({ ok: false, error: "Name is required." });
    expect(planProfileUpdate(fd({ preferred_name: "x".repeat(201) }), LOADED)).toMatchObject({ ok: false });
  });

  it("an old tab's name field never touches the preferred or legal names; those are other keys entirely", () => {
    const plan = planProfileUpdate(fd({ name: "Dana R. Reyes", legal_given_name: "Injected", legal_family_name: "Name" }), LOADED);
    expect(plan).toMatchObject({ ok: true, patch: { name: "Dana R. Reyes" } });
    if (plan.ok) expect(Object.keys(plan.patch)).toEqual(["name"]);
  });
});

describe("clearing the preferred name is an explicit action", () => {
  it("a blank without the explicit flag is refused", () => {
    expect(planProfileUpdate(fd({ preferred_name: "" }), LOADED)).toEqual({ ok: false, error: CLEAR_PREFERRED_ERROR });
  });
  it("a blank with clear_preferred_name=yes clears it (conditioned on the loaded value)", () => {
    expect(planProfileUpdate(fd({ preferred_name: "", clear_preferred_name: "yes" }), LOADED)).toEqual({
      ok: true, patch: { preferred_name: null }, conditions: [{ key: "preferred_name", value: "Dee" }],
    });
  });
  it("a blank where there was no preferred name is simply unchanged", () => {
    expect(planProfileUpdate(fd({ preferred_name: "" }), { ...LOADED, preferred_name: null })).toMatchObject({ ok: true, patch: {} });
  });
  it("the flag alone, with the field omitted, clears nothing", () => {
    expect(planProfileUpdate(fd({ clear_preferred_name: "yes" }), LOADED)).toMatchObject({ ok: true, patch: {} });
  });
});

describe("conflict review after a zero-row write", () => {
  it("names only the fields that no longer hold the loaded value, with both sides", () => {
    const plan = planProfileUpdate(fd({ phone: "778-555-0123", address: "2 New Rd" }), LOADED);
    if (!plan.ok) throw new Error("plan");
    const conflicts = describeConflicts(plan, { phone: "250-555-0000", address: "1 Test St", name: "Dana Reyes", date_of_birth: "1990-01-02" });
    expect(conflicts).toEqual([{ key: "phone", label: "Phone", current: "250-555-0000", yours: "778-555-0123" }]);
  });
  it("adopting the current value moves the baseline so a second save is not a false conflict", () => {
    const next = adoptCurrent(LOADED, [{ key: "phone", label: "Phone", current: "250-555-0000", yours: "x" }]);
    expect(next.phone).toBe("250-555-0000");
    expect(next.name).toBe(LOADED.name);
    expect(adoptCurrent(LOADED, [{ key: "allergies", label: "Allergies", current: "", yours: "x" }]).allergies).toBeNull();
  });
});

describe("identity fields are guarded together (Codex P2: the checked combination is the saved one)", () => {
  it("changing only the name also guards the stored phone and date of birth", () => {
    const plan = planProfileUpdate(fd({ name: "Dana R. Reyes" }), LOADED);
    expect(plan).toMatchObject({ ok: true, patch: { name: "Dana R. Reyes" } });
    if (plan.ok) {
      expect(plan.conditions).toEqual([
        { key: "name", value: "Dana Reyes" },
        { key: "phone", value: "604-555-0100", guard: true },
        { key: "date_of_birth", value: "1990-01-02", guard: true },
      ]);
    }
  });
  it("a non-identity change guards nothing extra", () => {
    const plan = planProfileUpdate(fd({ address: "2 New Rd" }), LOADED);
    if (plan.ok) expect(plan.conditions.every((c) => !c.guard)).toBe(true);
  });
  it("a moved guard field is reported as a conflict marked guard, with the value this page still showed", () => {
    const plan = planProfileUpdate(fd({ name: "Dana R. Reyes" }), LOADED);
    if (!plan.ok) throw new Error("plan");
    expect(describeConflicts(plan, { name: "Dana Reyes", phone: "604-555-0100", date_of_birth: "1991-05-05" })).toEqual([
      { key: "date_of_birth", label: "Date of birth", current: "1991-05-05", yours: "1990-01-02", guard: true },
    ]);
  });
});
