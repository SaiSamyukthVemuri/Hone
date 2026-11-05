import { describe, expect, it } from "vitest";
import { classifyUnexpected, attemptLanded, UNCERTAIN_SAVE_MESSAGE } from "@/lib/settings/roles/unexpected";
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
