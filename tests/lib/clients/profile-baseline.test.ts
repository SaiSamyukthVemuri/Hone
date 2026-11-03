import { describe, expect, it } from "vitest";
import {
  adoptCurrent,
  baselineFromRow,
  CLEAR_PREFERRED_ERROR,
  describeConflicts,
  MAX_BASELINE_CHARS,
  parseBaseline,
  planProfileUpdate,
  previewConflictValue,
  CONFLICT_PREVIEW_CHARS,
  splitConditions,
  URL_CONDITION_MAX_VALUE_CHARS,
  URL_CONDITION_TOTAL_CHARS,
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

describe("guard conflict, then Save again (Insurance Q-3)", () => {
  it("after the guard field is adopted, the same edit saves with no conflict against the stored row", () => {
    const edit = { name: "Dana R. Reyes" };
    const plan = planProfileUpdate(fd(edit), LOADED);
    if (!plan.ok) throw new Error("plan");
    // Someone else moved the phone after this page loaded.
    const stored = { name: "Dana Reyes", phone: "604-555-0199", date_of_birth: "1990-01-02" };
    const conflicts = describeConflicts(plan, stored);
    expect(conflicts).toEqual([{ key: "phone", label: "Phone", current: "604-555-0199", yours: "604-555-0100", guard: true }]);
    // The form adopts the current value (never writes the old one back) and the person presses Save again.
    const adopted = adoptCurrent(LOADED, conflicts);
    expect(adopted.phone).toBe("604-555-0199");
    const again = planProfileUpdate(fd({ ...edit, phone: "604-555-0199" }), adopted);
    if (!again.ok) throw new Error("plan again");
    expect(again.patch).toEqual({ name: "Dana R. Reyes" });
    expect(again.conditions).toContainEqual({ key: "phone", value: "604-555-0199", guard: true });
    expect(describeConflicts(again, stored)).toEqual([]);
  });
});

describe("a large stored profile stays editable (Codex P2: the old 20,000-character cap)", () => {
  it("round-trips a baseline with a >20k allergies field and a >20k address, and a small edit still plans", () => {
    const big = { ...LOADED, allergies: "a".repeat(25_000), address: "b".repeat(30_000) };
    const wire = JSON.stringify(baselineFromRow(big));
    expect(wire.length).toBeGreaterThan(20_000);
    expect(parseBaseline(wire)).toEqual(big);
    const plan = planProfileUpdate(fd({ pronouns: "they/them", allergies: big.allergies, address: big.address }), big);
    expect(plan).toEqual({ ok: true, patch: { pronouns: "they/them" }, conditions: [{ key: "pronouns", value: "she/her" }] });
  });
  it("still refuses a baseline beyond the sanity ceiling", () => {
    expect(parseBaseline(JSON.stringify({ ...LOADED, allergies: "a".repeat(MAX_BASELINE_CHARS) }))).toBeNull();
  });
});

describe("only URL-safe conditions travel in the URL (Insurance K-1, option E)", () => {
  const size = (v: unknown) => encodeURIComponent(String(v ?? "null")).length;
  it("a small edit keeps every condition in the URL", () => {
    const plan = planProfileUpdate(fd({ phone: "604-555-0199" }), LOADED);
    if (!plan.ok) throw new Error("plan");
    const { inUrl, unconditioned } = splitConditions(plan.conditions);
    expect(unconditioned).toEqual([]);
    expect(inUrl).toEqual(plan.conditions);
  });
  it("a changed 25k allergies field is written without its own condition; the short guards keep theirs", () => {
    const big = { ...LOADED, allergies: "a".repeat(25_000), address: "b".repeat(30_000) };
    const plan = planProfileUpdate(fd({ allergies: big.allergies + "Y", name: "Dana R. Reyes" }), big);
    if (!plan.ok) throw new Error("plan");
    const { inUrl, unconditioned } = splitConditions(plan.conditions);
    expect(unconditioned.map((c) => c.key)).toEqual(["allergies"]);
    expect(inUrl.map((c) => c.key).sort()).toEqual(["date_of_birth", "name", "phone"]);
    expect(plan.patch.allergies).toBe(big.allergies + "Y"); // the new value is still written
  });
  it("both large fields changed: neither has a condition, the small stale guard still applies", () => {
    const big = { ...LOADED, allergies: "a".repeat(25_000), address: "b".repeat(30_000) };
    const plan = planProfileUpdate(fd({ allergies: big.allergies + "Y", address: big.address + "X", pronouns: "they/them" }), big);
    if (!plan.ok) throw new Error("plan");
    const { inUrl, unconditioned } = splitConditions(plan.conditions);
    expect(unconditioned.map((c) => c.key).sort()).toEqual(["address", "allergies"]);
    expect(inUrl).toEqual([{ key: "pronouns", value: "she/her" }]);
  });
  it("the per-value threshold is on the ENCODED length", () => {
    const justUnder = "a".repeat(URL_CONDITION_MAX_VALUE_CHARS);
    const encodedOver = "é".repeat(URL_CONDITION_MAX_VALUE_CHARS / 2 + 1); // 2 bytes each, 6 chars encoded in total over the cap
    expect(splitConditions([{ key: "address" as const, value: justUnder }]).inUrl).toHaveLength(1);
    expect(size(encodedOver)).toBeGreaterThan(URL_CONDITION_MAX_VALUE_CHARS);
    expect(splitConditions([{ key: "address" as const, value: encodedOver }]).unconditioned).toHaveLength(1);
  });
  it("the TOTAL cap drops the largest remaining conditions, never a small one first, and never exceeds the cap", () => {
    const value = "m".repeat(1_500);
    const conds = (["name", "pronouns", "email", "address", "allergies"] as const).map((key) => ({ key, value }));
    const { inUrl, unconditioned } = splitConditions(conds);
    expect(inUrl.length + unconditioned.length).toBe(conds.length);
    expect(inUrl.reduce((n, c) => n + size(c.value), 0)).toBeLessThanOrEqual(URL_CONDITION_TOTAL_CHARS);
    expect(unconditioned.length).toBeGreaterThan(0);
    const mixed = [{ key: "address" as const, value }, { key: "pronouns" as const, value: "she/her" }, { key: "email" as const, value }, { key: "allergies" as const, value }, { key: "name" as const, value }];
    expect(splitConditions(mixed).inUrl.map((c) => c.key)).toContain("pronouns");
  });
  it("a null baseline costs almost nothing and is always kept", () => {
    expect(splitConditions([{ key: "allergies" as const, value: null }]).inUrl).toHaveLength(1);
  });
});

describe("a long field changed underneath is a conflict, not a silent overwrite (Privacy R1)", () => {
  const big = { ...LOADED, allergies: "a".repeat(25_000) };
  const plan = (() => {
    const p = planProfileUpdate(fd({ allergies: big.allergies + "Y", pronouns: "they/them" }), big);
    if (!p.ok) throw new Error("plan");
    return p;
  })();
  const { unconditioned } = splitConditions(plan.conditions);
  const check = (stored: Record<string, unknown>) => describeConflicts({ ...plan, conditions: unconditioned }, stored);
  it("only the long field is checked by reading; the short field keeps its URL condition", () => {
    expect(unconditioned.map((c) => c.key)).toEqual(["allergies"]);
  });
  it("a colleague's change to the long field is reported with their current text and the draft value", () => {
    const c = check({ allergies: "latex (added by a colleague)" });
    expect(c).toEqual([{ key: "allergies", label: "Allergies", current: "latex (added by a colleague)", yours: big.allergies + "Y" }]);
  });
  it("the same stored value is no conflict, and a cleared field is a conflict", () => {
    expect(check({ allergies: big.allergies })).toEqual([]);
    expect(check({ allergies: null })).toHaveLength(1);
  });
});

describe("the conflict panel stays usable with a very long value (Insurance M-4)", () => {
  it("short values are shown as they are, empty as (empty)", () => {
    expect(previewConflictValue("latex")).toBe("latex");
    expect(previewConflictValue("")).toBe("(empty)");
  });
  it("a 25,000-character value is clipped to the preview length plus its true size", () => {
    const out = previewConflictValue("a".repeat(25_000));
    expect(out.startsWith("a".repeat(CONFLICT_PREVIEW_CHARS) + "…")).toBe(true);
    expect(out).toContain("25,000 characters in all");
    expect(out.length).toBeLessThan(CONFLICT_PREVIEW_CHARS + 60);
  });
});
