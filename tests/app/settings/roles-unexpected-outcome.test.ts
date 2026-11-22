import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyUnexpected, attemptLanded, rebaseDrafts, UNCERTAIN_SAVE_MESSAGE } from "@/lib/settings/roles/unexpected";
import type { Role, StudioPolicy } from "@/lib/permissions/catalog";

// Codex P2 (#1335 r4468821021): a version bump after an 'unexpected' failure is not proof that THIS save landed. Synthetic keys only.

const policies = (values: Record<Role, Record<string, string>>) => values as unknown as Record<Role, StudioPolicy>;
const withValues = (practitioner: Record<string, string>, receptionist: Record<string, string> = {}) =>
  policies({ practitioner: { values: practitioner }, receptionist: { values: receptionist } } as never);

const attempted = { receptionist: { "k.one": "own" } } as never;

describe("classifyUnexpected", () => {
  it("(a) another writer commits and our request fails: version moved, our set absent -> uncertain, draft kept", () => {
    const fresh = { version: 8, policies: withValues({}, { "k.one": "studio", "k.other": "off" }) };
    expect(classifyUnexpected({ boundVersion: 7, attempted, fresh })).toBe("uncertain");
    expect(UNCERTAIN_SAVE_MESSAGE).toBe("We couldn't confirm your change was saved. Review the current permissions below.");
  });
  it("(b) our change landed: the exact attempted set is stored -> landed", () => {
    const fresh = { version: 8, policies: withValues({}, { "k.one": "own" }) };
    expect(classifyUnexpected({ boundVersion: 7, attempted, fresh })).toBe("landed");
  });
  it("a revocation is judged the same way as a widening", () => {
    const revoke = { receptionist: { "k.one": "off" } } as never;
    expect(classifyUnexpected({ boundVersion: 7, attempted: revoke, fresh: { version: 8, policies: withValues({}, { "k.one": "studio" }) } })).toBe("uncertain");
    expect(classifyUnexpected({ boundVersion: 7, attempted: revoke, fresh: { version: 8, policies: withValues({}, { "k.one": "off" }) } })).toBe("landed");
  });
  it("a partial match is not a landing", () => {
    const two = { receptionist: { "k.one": "own", "k.two": "off" } } as never;
    expect(attemptLanded(two, withValues({}, { "k.one": "own", "k.two": "studio" }))).toBe(false);
  });
  it("reset and adopt state no attempted set, so a moved version is never proof", () => {
    expect(classifyUnexpected({ boundVersion: 7, attempted: null, fresh: { version: 8, policies: withValues({}) } })).toBe("uncertain");
    expect(classifyUnexpected({ boundVersion: 7, attempted: {}, fresh: { version: 8, policies: withValues({}) } })).toBe("uncertain");
  });
  it("same version means nothing changed; an unreadable policy is said plainly", () => {
    expect(classifyUnexpected({ boundVersion: 7, attempted, fresh: { version: 7, policies: withValues({}) } })).toBe("unchanged");
    expect(classifyUnexpected({ boundVersion: 7, attempted, fresh: null })).toBe("unreadable");
  });
});

// Codex P2 (#1335 f2bee2d07, roles-editor.tsx:319): after an uncertain save the whole old draft was kept, so another owner's concurrent
// change to a key this owner never touched looked like an edit to undo on the next save. Synthetic keys only.
describe("rebaseDrafts: only this owner's own choices survive an uncertain save", () => {
  const P = (practitioner: Record<string, string>, receptionist: Record<string, string> = {}) => withValues(practitioner, receptionist);

  it("a concurrent second-owner change to a DIFFERENT permission survives (it is not turned into an edit to undo)", () => {
    const oldSaved = P({ "k.records": "own", "k.photos": "own" });
    const drafts = P({ "k.records": "off", "k.photos": "own" }); // this owner turned records off
    const fresh = P({ "k.records": "own", "k.photos": "off" }); // another owner turned photos off meanwhile; our save did not commit
    const rebased = rebaseDrafts(drafts, oldSaved, fresh);
    expect(rebased.practitioner.values).toEqual({ "k.records": "off", "k.photos": "off" });
    // The next save would now send ONLY the key this owner changed.
    const edits = Object.entries(rebased.practitioner.values).filter(([k, v]) => (fresh.practitioner.values as Record<string, string>)[k] !== v);
    expect(edits).toEqual([["k.records", "off"]]);
  });
  it("this owner's own choice is kept even when the other owner changed the same key", () => {
    const oldSaved = P({ "k.one": "studio" });
    const rebased = rebaseDrafts(P({ "k.one": "own" }), oldSaved, P({ "k.one": "off" }));
    expect(rebased.practitioner.values).toEqual({ "k.one": "own" });
  });
  it("a reverted edit (explicit basis value where nothing was saved) is NOT carried over, so it cannot overwrite a concurrent change (Codex P2 4620000808)", () => {
    // appt.cancel for a practitioner on the new-studio basis defaults to studio. The owner changed it to off and back: the draft holds an
    // explicit studio, the saved policy holds nothing, and they are the same choice. Another owner set it to own meanwhile.
    const basis = { basis: "new_studio" };
    const oldSaved = { practitioner: { ...basis, values: {} }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    const drafts = { practitioner: { ...basis, values: { "appt.cancel": "studio" } }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    const fresh = { practitioner: { ...basis, values: { "appt.cancel": "own" } }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    expect(rebaseDrafts(drafts, oldSaved, fresh).practitioner.values).toEqual({ "appt.cancel": "own" });
  });
  it("control: a real edit of that key (off, not the basis value) is still carried over", () => {
    const basis = { basis: "new_studio" };
    const oldSaved = { practitioner: { ...basis, values: {} }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    const drafts = { practitioner: { ...basis, values: { "appt.cancel": "off" } }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    const fresh = { practitioner: { ...basis, values: { "appt.cancel": "own" } }, receptionist: { ...basis, values: {} } } as unknown as Record<Role, StudioPolicy>;
    expect(rebaseDrafts(drafts, oldSaved, fresh).practitioner.values).toEqual({ "appt.cancel": "off" });
  });
  it("a choice that already equals the fresh value drops out as an edit", () => {
    const rebased = rebaseDrafts(P({ "k.one": "own" }), P({ "k.one": "studio" }), P({ "k.one": "own" }));
    expect(rebased.practitioner.values).toEqual({ "k.one": "own" });
  });
  it("an untouched draft becomes exactly the fresh policy, on both roles", () => {
    const same = P({ "k.one": "studio" }, { "k.two": "off" });
    const fresh = P({ "k.one": "own", "k.new": "off" }, { "k.two": "studio" });
    const rebased = rebaseDrafts(same, same, fresh);
    expect(rebased.practitioner.values).toEqual(fresh.practitioner.values);
    expect(rebased.receptionist.values).toEqual(fresh.receptionist.values);
  });
  it("basis and gates come from the FRESH policy, never from the draft", () => {
    const mk = (basis: string, gate: boolean, v: Record<string, string>) =>
      ({ basis, values: v, gates: { receptionist_finance: gate } }) as unknown as StudioPolicy;
    const both = (practitioner: StudioPolicy, receptionist: StudioPolicy) => ({ practitioner, receptionist }) as Record<Role, StudioPolicy>;
    const oldSaved = both(mk("existing_snapshot", false, { "k.one": "own" }), mk("existing_snapshot", false, {}));
    const drafts = both(mk("existing_snapshot", false, { "k.one": "off" }), mk("existing_snapshot", false, {}));
    const fresh = both(mk("new_studio", true, { "k.one": "own" }), mk("new_studio", true, {}));
    const rebased = rebaseDrafts(drafts, oldSaved, fresh);
    for (const r of ["practitioner", "receptionist"] as Role[]) {
      expect(rebased[r].basis, r).toBe("new_studio");
      expect(rebased[r].gates, r).toEqual({ receptionist_finance: true });
    }
    expect(rebased.practitioner.values).toEqual({ "k.one": "off" }); // the owner's own choice still wins
  });
  it("the editor's uncertain path rebases instead of keeping the old draft", () => {
    const src = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
    const at = src.indexOf("feedback.failed(UNCERTAIN_SAVE_MESSAGE)");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, at - 400), at)).toContain("rebaseDrafts(current, saved, fresh.state.policies)");
  });
});
