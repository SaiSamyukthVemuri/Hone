import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// G1, from Codex's two P2 findings at 12033879. Both were one defect class:
// the picker's SURFACE and the question the SERVER answers disagreeing.
//
// THESE ARE SOURCE CONTRACTS, which are weaker than behavioural proof, and the
// reason is recorded rather than hidden: there is no render harness for
// PublicBookForm anywhere in the suite — every existing test of this file
// (referral-source-wiring, marketing-consent-compact, new-client-waitlist-ui,
// admission-presentation-order) greps its source. Adding a React harness for
// two guards is a bigger change than the fixes. The behavioural half lives in
// e2e/public-practitioner-picker.spec.ts, which proves scoped slots, parallel
// booking and same-practitioner refusal against real database rows.

const REPO_ROOT = path.resolve(__dirname, "../../..");
const FORM = readFileSync(
  path.join(REPO_ROOT, "app/book/[slug]/PublicBookForm.tsx"),
  "utf8",
);
const ACTIONS = readFileSync(
  path.join(REPO_ROOT, "app/book/[slug]/actions.ts"),
  "utf8",
);

describe("G1: a hidden picker still submits its only answer", () => {
  // THE DEFECT: the picker renders only when there is more than one eligible
  // practitioner. With exactly one, the control was hidden and practitionerId
  // was left empty, so submission sent NULL -- and NULL means "any available",
  // which create_public_appointment_v2 resolves down its legacy ACTIVE-OWNER
  // path. A service pinned to a single NON-OWNER practitioner therefore
  // displayed that practitioner's slots and then refused the booking as
  // `not_eligible`.
  it("assigns the sole eligible option instead of leaving NULL", () => {
    expect(
      FORM,
      "a one-option picker is hidden for being noise; its ANSWER must still " +
        "be submitted, or NULL sends the booking down the active-owner path",
    ).toMatch(/options\.length === 1\s*\)\s*setPractitionerId\(/);
  });

  it("still hides the control itself when there is nothing to choose", () => {
    // Anti-overreach: the fix is about the submitted VALUE, not about showing a
    // pointless dropdown.
    expect(FORM).toMatch(/pickerApplies && practitionerOptions\.length > 1/);
  });
});

describe("G1: the studio-wide jump is not offered against a chosen practitioner", () => {
  // THE DEFECT: "Next available" calls fetchNextAvailableDateAction, which is
  // studio-wide BY CONSTRUCTION -- it hands the window to
  // loadPublicSlotsByDate, whose PublicRangeContext has no practitioner field
  // and whose reservation read filters on studio_id alone. With a practitioner
  // selected it answered a different question than the grid beneath it: it
  // could skip a date they are free on (every other practitioner's booking
  // counts as a conflict) and land on a date whose scoped grid is empty.
  it("gates the jump on no specific practitioner being chosen", () => {
    expect(FORM).toMatch(
      /const nextAvailableApplies = !\(pickerApplies && practitionerId\)/,
    );
  });

  it("gates EVERY next-available surface, not just the empty-grid one", () => {
    // There are two surfaces (empty grid and populated grid) sharing one
    // handler. Gating one and forgetting the other is the obvious way for this
    // fix to half-land.
    const gated = FORM.match(/!nextAvailableApplies \? null :/g) ?? [];
    const handlers = FORM.match(/onClick=\{onFindNext\}/g) ?? [];
    expect(handlers.length, "expected both jump buttons to still exist").toBe(2);
    expect(
      gated.length,
      "every onFindNext surface must sit behind the gate",
    ).toBe(handlers.length);
  });

  it("does NOT pass a practitioner to the studio-wide action", () => {
    // The tempting fix was to thread the selection through and scope per date.
    // next-available-bounded.test.ts forbids exactly that: no getAvailableSlots
    // in that action, loadPublicSlotsByDate required, and no await inside a
    // loop (BOOK-NEXT-FAST-01). Scoping the jump means making the BULK pass
    // practitioner-aware, which needs its own slice -- see the comment on
    // nextAvailableApplies. This pins the boundary so a later edit does not
    // quietly reintroduce the per-day scan.
    const sig = ACTIONS.match(
      /export async function fetchNextAvailableDateAction\(params: \{[^}]*\}/,
    );
    expect(sig, "expected the action's parameter object").not.toBeNull();
    expect(sig![0]).not.toContain("practitionerId");
  });
});
