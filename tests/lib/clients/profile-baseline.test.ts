import { describe, expect, it } from "vitest";
import {
  adoptCurrent,
  baselineFromRow,
  CLEAR_PREFERRED_ERROR,
  describeConflicts,
  MAX_BASELINE_CHARS,
  parseBaseline,
  planProfileUpdate,
  applyMineAllowed,
  conflictOpenedKey,
  conflictPreview,
  CONFLICT_WHITESPACE_ONLY_NOTE,
  CONFLICT_SCROLL_PAD_PX,
  CONFLICT_RESYNC_WINDOW_POINTS,
  scrollTopForMark,
  previewFor,
  sidesToOpen,
  needsFullTextOpen,
  CONFLICT_FULL_CHARS,
  CONFLICT_REGION_MAX_CHARS,
  CONFLICT_CONTEXT_CHARS,
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

describe("the conflict panel shows the DIFFERING region of a long value (Insurance M-4, M-6)", () => {
  const base = "x".repeat(10_000);
  it("short pairs are shown whole, empty as (empty)", () => {
    const p = conflictPreview("latex", "");
    expect(p.current).toEqual({ text: "latex", clipped: false, regionTruncated: false, full: "latex", diffStart: 0, diffEnd: 0 });
    expect(p.yours.text).toBe("(empty)");
  });
  it("an allergy appended at the END is visible on the side that has it (the head-only clip hid it)", () => {
    const p = conflictPreview(base + " | penicillin", base);
    expect(p.current.clipped).toBe(true);
    expect(p.current.text).toContain("penicillin");
    expect(p.current.text.startsWith("…")).toBe(true);
    expect(p.current.full).toBe(base + " | penicillin");
    expect(p.current.text.length).toBeLessThan(CONFLICT_CONTEXT_CHARS * 2 + 100);
    expect(p.yours.text).not.toContain("penicillin");
  });
  it("the same append on the draft side shows it under 'your change'", () => {
    const p = conflictPreview(base, base + " | my note");
    expect(p.yours.text).toContain("my note");
    expect(p.current.text).not.toContain("my note");
  });
  it("an insert in the MIDDLE shows the inserted text with context on both sides", () => {
    const a = "L".repeat(5_000) + "R".repeat(5_000);
    const b = "L".repeat(5_000) + " | latex | " + "R".repeat(5_000);
    const p = conflictPreview(a, b);
    expect(p.yours.text).toContain("latex");
    expect(p.yours.text.startsWith("…")).toBe(true);
    expect(p.yours.text.endsWith("…")).toBe(true);
    expect(p.current.text.length).toBeLessThan(CONFLICT_CONTEXT_CHARS * 2 + 40);
  });
  it("a DELETION shows the removed text on the side that still has it", () => {
    const a = "A".repeat(5_000) + " | nuts | " + "B".repeat(5_000);
    const b = "A".repeat(5_000) + "B".repeat(5_000);
    const p = conflictPreview(a, b);
    expect(p.current.text).toContain("nuts");
    expect(p.yours.text).not.toContain("nuts");
  });
  it("identical-prefix values that differ only in the last characters are told apart", () => {
    const p = conflictPreview(base + "ab", base + "ac");
    expect(p.current.text.endsWith("ab")).toBe(true);
    expect(p.yours.text.endsWith("ac")).toBe(true);
    expect(p.current.text).not.toBe(p.yours.text);
  });
  it("values that differ everywhere are capped but the full text stays available", () => {
    const p = conflictPreview("a".repeat(25_000), "b".repeat(25_000));
    expect(p.current.text.length).toBeLessThanOrEqual(CONFLICT_CONTEXT_CHARS + 700);
    expect(p.current.full.length).toBe(25_000);
    expect(p.yours.full.length).toBe(25_000);
  });
  it("a pair one of which is short and one long still clips only the long side", () => {
    const p = conflictPreview("latex", base);
    expect(p.current.clipped).toBe(false);
    expect(p.yours.clipped).toBe(true);
    expect(CONFLICT_FULL_CHARS).toBeLessThan(base.length);
  });
});

describe("two distant edits cannot hide the second one (Insurance M-8, M-9, M-10, M-11)", () => {
  const mid = "m".repeat(3_000);
  const now = "FIRST-EDIT" + mid + "tail";
  const yours = "first" + mid + "tail-SECOND-EDIT";
  const conflict = { key: "allergies" as const, current: now, yours };

  it("edits further apart than the cap produce a clipped, truncated region on both sides", () => {
    const p = conflictPreview(now, yours);
    expect(p.current.clipped && p.yours.clipped).toBe(true);
    expect(p.current.regionTruncated).toBe(true);
    expect(p.yours.regionTruncated).toBe(true);
    // the second edit is NOT in the preview: that is exactly why the person must open the full text
    expect(p.yours.text).not.toContain("SECOND-EDIT");
    expect(p.yours.full).toContain("SECOND-EDIT");
    expect(needsFullTextOpen(conflict)).toBe(true);
  });
  it("an append at the end (region inside the cap) is not truncated and needs no gate", () => {
    const base = "x".repeat(10_000);
    const p = conflictPreview(base + " | penicillin", base);
    expect(p.current.regionTruncated).toBe(false);
    expect(needsFullTextOpen({ current: base + " | penicillin", yours: base })).toBe(false);
  });
  it("Apply is gated until EVERY clipped side of that conflict has been opened, then it releases", () => {
    const cur = conflictOpenedKey("allergies", "current");
    const yrs = conflictOpenedKey("allergies", "yours");
    expect(sidesToOpen(conflict)).toEqual(["current", "yours"]);
    expect(applyMineAllowed([conflict], new Set())).toBe(false);
    expect(applyMineAllowed([conflict], new Set([conflictOpenedKey("pronouns", "current")]))).toBe(false); // another field's expand does not release it
    expect(applyMineAllowed([conflict], new Set([cur]))).toBe(false);
    expect(applyMineAllowed([conflict], new Set([yrs]))).toBe(false);
    expect(applyMineAllowed([conflict], new Set([cur, yrs]))).toBe(true);
  });
  it("an unclipped conflict never needs the gate, and a mixed set needs every truncated one opened", () => {
    const small = { key: "pronouns" as const, current: "she/her", yours: "they/them" };
    const both = new Set([conflictOpenedKey("allergies", "current"), conflictOpenedKey("allergies", "yours")]);
    expect(applyMineAllowed([small], new Set())).toBe(true);
    expect(applyMineAllowed([small, conflict], new Set())).toBe(false);
    expect(applyMineAllowed([small, conflict], both)).toBe(true);
  });
  it("clips on code points: an emoji at the cut is never split into a lone surrogate", () => {
    const emoji = "😀";
    // put astral characters across the region boundaries
    const a = emoji.repeat(2_000) + "A" + emoji.repeat(2_000);
    const b = emoji.repeat(2_000) + "B" + emoji.repeat(2_000);
    const p = conflictPreview(a, b);
    for (const side of [p.current, p.yours]) {
      expect(side.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
      expect(side.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // no lone low surrogate
    }
    expect(p.current.text).toContain("A");
    expect(p.yours.text).toContain("B");
  });
  it("a region cut at the cap with astral characters is still whole code points", () => {
    const emoji = "😀";
    const a = "S" + emoji.repeat(CONFLICT_REGION_MAX_CHARS + 500) + "E";
    const b = "T" + emoji.repeat(CONFLICT_REGION_MAX_CHARS + 500) + "F";
    const p = conflictPreview(a, b);
    expect(p.current.regionTruncated).toBe(true);
    expect(p.current.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(p.current.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("asymmetric conflicts are never a dead end (Insurance N-1, Privacy Z1)", () => {
  // "now" is short and shown whole; "your change" is long, far-apart, and clipped. A side shown whole counts as seen.
  const yours = "FIRST" + "m".repeat(3_000) + "LAST";
  const conflict = { key: "allergies" as const, current: "latex", yours };

  it("only the clipped side must be opened; the whole side is already seen", () => {
    const p = previewFor(conflict);
    expect(p.current.clipped).toBe(false);
    expect(p.yours.clipped && p.yours.regionTruncated).toBe(true);
    expect(sidesToOpen(conflict)).toEqual(["yours"]);
  });
  it("Apply stays disabled until the clipped side is opened, then enables", () => {
    expect(applyMineAllowed([conflict], new Set())).toBe(false);
    expect(applyMineAllowed([conflict], new Set([conflictOpenedKey("allergies", "current")]))).toBe(false);
    expect(applyMineAllowed([conflict], new Set([conflictOpenedKey("allergies", "yours")]))).toBe(true);
  });
  it("the mirror case (long clipped now, short yours) needs the current side", () => {
    const mirror = { key: "allergies" as const, current: yours, yours: "latex" };
    expect(sidesToOpen(mirror)).toEqual(["current"]);
    expect(applyMineAllowed([mirror], new Set([conflictOpenedKey("allergies", "current")]))).toBe(true);
  });
  it("records where the differing region sits in the full text so the expanded box can scroll to it", () => {
    const base = "x".repeat(2_000);
    const p = conflictPreview(base + "AAA" + "y".repeat(2_000), base + "BBB" + "y".repeat(2_000));
    expect(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).toBe("AAA");
    expect(p.yours.full.slice(p.yours.diffStart, p.yours.diffEnd)).toBe("BBB");
  });
});

describe("whitespace-only conflicts are labelled (Insurance N-3)", () => {
  it("flags a pair that differs only in spaces or line breaks, short or long", () => {
    expect(conflictPreview("a b", "a  b").whitespaceOnly).toBe(true);
    expect(conflictPreview("a\nb", "a b").whitespaceOnly).toBe(true);
    expect(conflictPreview(" a  b ", "a b").whitespaceOnly).toBe(true);
    const long = "word ".repeat(200);
    expect(conflictPreview(long, long.replace(/ /g, "\n")).whitespaceOnly).toBe(true);
    expect(CONFLICT_WHITESPACE_ONLY_NOTE).toMatch(/spaces or line breaks/);
  });
  it("does not flag a real difference or an identical pair", () => {
    expect(conflictPreview("a b", "a c").whitespaceOnly).toBe(false);
    expect(conflictPreview("a b", "ab").whitespaceOnly).toBe(false); // N5-2: removing the only space is a real change
    expect(conflictPreview("a b", "a b").whitespaceOnly).toBe(false);
    expect(conflictPreview("latex", "").whitespaceOnly).toBe(false);
  });
});

describe("preview memoisation (N-4/Z2)", () => {
  it("returns the same object for the same conflict and recomputes if its text changes", () => {
    const c = { key: "allergies" as const, current: "x".repeat(400), yours: "y".repeat(400) };
    expect(previewFor(c)).toBe(previewFor(c));
    const first = previewFor(c);
    const changed = { ...c, yours: "z".repeat(400) };
    expect(previewFor(changed)).not.toBe(first);
  });
});

describe("scroll arithmetic and the first differing run (W-1/N5-1, W-2)", () => {
  it("the mark's offsetTop is box-relative: scrollTop is that minus the pad, never negative, and never subtracts the box", () => {
    expect(scrollTopForMark(500)).toBe(500 - CONFLICT_SCROLL_PAD_PX);
    expect(scrollTopForMark(10)).toBe(0);
    expect(scrollTopForMark(0)).toBe(0);
  });
  it("two distant edits: only the FIRST run is marked and moreChanges is set", () => {
    const mid = "m".repeat(3_000);
    const p = conflictPreview("FIRST" + mid + "tail", "first" + mid + "tail-SECOND");
    expect(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).toBe("FIRST");
    expect(p.yours.full.slice(p.yours.diffStart, p.yours.diffEnd)).toBe("first");
    expect(p.moreChanges).toBe(true);
  });
  it("a single run reports no more changes", () => {
    const base = "x".repeat(2_000);
    expect(conflictPreview(base + "AAA" + "y".repeat(2_000), base + "BBB" + "y".repeat(2_000)).moreChanges).toBe(false);
    expect(conflictPreview("x".repeat(400), "x".repeat(400) + "!").moreChanges).toBe(false);
  });
});

describe("bounded re-sync search (P-1/R6-1)", () => {
  // Distinct, non-repeating text so an anchor can only match where it truly re-appears.
  const unique = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(5, "0")} `).join("");

  /** Runs conflictPreview while counting String.prototype.indexOf calls: the work bound, independent of machine speed. */
  function withIndexOfCount<T>(fn: () => T): { result: T; calls: number } {
    const original = String.prototype.indexOf;
    let calls = 0;
    String.prototype.indexOf = function (this: string, ...args: Parameters<typeof original>) {
      calls += 1;
      return original.apply(this, args);
    } as typeof original;
    try {
      return { result: fn(), calls };
    } finally {
      String.prototype.indexOf = original;
    }
  }

  it("30,000-character values with edits at both ends do a bounded number of searches", () => {
    const mid = "m".repeat(29_900);
    const { result: p, calls } = withIndexOfCount(() => conflictPreview("FIRST" + mid + "tail-A", "first" + mid + "tail-B"));
    expect(calls).toBeLessThanOrEqual(CONFLICT_RESYNC_WINDOW_POINTS + 1);
    expect(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).toBe("FIRST");
    expect(p.moreChanges).toBe(true);
  });
  it("completely different 30,000-character values stay inside the window bound and say more changes follow", () => {
    const t0 = performance.now();
    const { result: p, calls } = withIndexOfCount(() => conflictPreview("a".repeat(30_000), "b".repeat(30_000)));
    expect(calls).toBeLessThanOrEqual(CONFLICT_RESYNC_WINDOW_POINTS + 1);
    expect(performance.now() - t0).toBeLessThan(2_000); // generous ceiling only; the call count above is the real bound
    expect(p.moreChanges).toBe(true);
    expect(Array.from(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).length).toBe(CONFLICT_RESYNC_WINDOW_POINTS);
  });
  it("a re-sync only PAST the window is not found: the run ends exactly at the window and more changes are reported", () => {
    // Both sides differ for far more than 4,000 code points, then share a unique tail that could re-sync them.
    const common = unique("tail", 40);
    const a = unique("a", 800) + common;
    const b = unique("b", 800) + common;
    expect(Array.from(unique("a", 800)).length).toBeGreaterThan(CONFLICT_RESYNC_WINDOW_POINTS);
    const { result: p, calls } = withIndexOfCount(() => conflictPreview(a, b));
    expect(calls).toBeLessThanOrEqual(CONFLICT_RESYNC_WINDOW_POINTS + 1);
    // Only the window-end path returns a run of exactly the window length on both sides.
    expect(Array.from(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).length).toBe(CONFLICT_RESYNC_WINDOW_POINTS);
    expect(Array.from(p.yours.full.slice(p.yours.diffStart, p.yours.diffEnd)).length).toBe(CONFLICT_RESYNC_WINDOW_POINTS);
    expect(p.moreChanges).toBe(true);
  });
  it("a re-sync INSIDE the window is found (control for the beyond-window case)", () => {
    const common = unique("tail", 40);
    const a = unique("a", 50) + common;
    const b = unique("b", 50) + common;
    const p = conflictPreview(a, b);
    expect(Array.from(p.current.full.slice(p.current.diffStart, p.current.diffEnd)).length).toBeLessThan(CONFLICT_RESYNC_WINDOW_POINTS);
    expect(p.moreChanges).toBe(false);
  });
});
