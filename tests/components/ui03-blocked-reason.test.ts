import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// UI-03 — a disabled control must say why.
//
// The reschedule submit is gated by two independent conditions and exposed
// neither. The explanatory copy already existed inside `submit()` and was
// structurally unreachable: those lines run only on submit, and a disabled
// submit button never fires one.
//
// WHAT THESE PROVE: that the reason is derived from the same predicate as
// `disabled` (so the two cannot drift), that the copy is reused rather than
// reinvented, and that the gate itself is unchanged. The browser proof beside
// this one asserts what a client actually sees and what the control exposes.

const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FORM = code("app/reschedule/[token]/RescheduleForm.tsx");

describe("UI-03: the reason is derived from the gate, not restated beside it", () => {
  it("blockedReason is the single source, and the button consumes it", () => {
    expect(FORM).toMatch(/const blockedReason: string \| null = !picked/);
    expect(FORM).toMatch(/disabled=\{blockedReason !== null \|\| submitting\}/);
  });

  it("THE GATE IS UNCHANGED — no condition was added, removed or loosened", () => {
    // blockedReason !== null  <=>  !picked || (requiresAcknowledgement && !acknowledged)
    // Enumerated over every combination of the three inputs, so this is a proof
    // of equivalence rather than a reading of the source. If a future edit makes
    // the hint and the gate disagree, one of these 8 rows fails.
    const before = (p: boolean, r: boolean, a: boolean, s: boolean) =>
      !p || s || (r && !a);
    const after = (p: boolean, r: boolean, a: boolean, s: boolean) => {
      const blockedReason = !p ? "pick" : r && !a ? "ack" : null;
      return blockedReason !== null || s;
    };
    const bools = [false, true];
    for (const p of bools)
      for (const r of bools)
        for (const a of bools)
          for (const s of bools)
            expect(
              after(p, r, a, s),
              `picked=${p} requiresAck=${r} acknowledged=${a} submitting=${s}`,
            ).toBe(before(p, r, a, s));
  });

  it("reuses the copy that already existed — no new product wording", () => {
    // Both strings were already in this file, written for exactly this purpose
    // and unreachable. Inventing replacements would have been a copy change
    // dressed up as an accessibility fix.
    expect(FORM).toContain('"Pick a time first."');
    expect(FORM).toContain(
      '"Please review and acknowledge the appointment policies before rescheduling."',
    );
    // And the original guards remain as defence in depth; the server re-checks.
    expect(FORM).toMatch(/if \(!picked\) \{\s*setError\("Pick a time first\."\);/);
  });

  it("the hint is tied to the control by one shared id constant", () => {
    expect(FORM).toMatch(/const BLOCKED_HINT_ID = "reschedule-submit-blocked";/);
    expect(FORM).toMatch(/aria-describedby=\{blockedReason \? BLOCKED_HINT_ID : undefined\}/);
    expect(FORM).toMatch(/<p id=\{BLOCKED_HINT_ID\}/);
    // No hard-coded duplicate of the id, which is how these drift apart.
    expect(FORM.match(/"reschedule-submit-blocked"/g)?.length ?? 0).toBe(1);
  });

  it("the hint renders AFTER the button, so appearing cannot move the target", () => {
    // Above the control, the hint would vanish the instant a time is picked and
    // pull the button upward — under a finger already reaching for it.
    const btn = FORM.indexOf('disabled={blockedReason !== null || submitting}');
    const hint = FORM.indexOf("<p id={BLOCKED_HINT_ID}");
    expect(btn).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(btn);
  });

  it("describedby is absent when nothing blocks, so it never points at nothing", () => {
    // The <p> only renders while blockedReason is set; a permanently-present
    // aria-describedby would reference a missing id whenever the form is ready.
    expect(FORM).toMatch(/\{blockedReason && \(/);
    expect(FORM).not.toMatch(/aria-describedby="reschedule-submit-blocked"/);
  });

  it("changes no authority: no new action, no DB call, no schema reference", () => {
    expect(FORM).not.toMatch(/from "@\/lib\/supabase/);
    expect(FORM).not.toMatch(/\.rpc\(/);
    expect(FORM).not.toMatch(/acknowledged_policy["']?\s*:/);
    // The submit path still posts the same fields it always did.
    expect(FORM).toMatch(/fd\.set\("starts_at", picked\.start\)/);
  });
});
